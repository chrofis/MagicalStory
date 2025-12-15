# MagicalStory Documentation Index

**Last Updated:** 2025-12-15
**Platform:** Web Application (React + Node.js)
**Hosting:** Railway
**Domain:** magicalstory.ch

---

## Quick Links

| Document | Description | Status |
|----------|-------------|--------|
| [README.md](README.md) | Project overview and quick start | Current |
| [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) | How to deploy to Railway/Render | Current |
| [EMAIL_SETUP_GUIDE.md](EMAIL_SETUP_GUIDE.md) | Resend email configuration | Current |
| [docs/PIPELINE_ANALYSIS.md](docs/PIPELINE_ANALYSIS.md) | Story generation pipeline details | Current |

---

## Current Architecture

### Tech Stack
- **Frontend:** React 18 + Vite + TypeScript + Tailwind CSS
- **Backend:** Node.js + Express.js
- **Database:** PostgreSQL (Railway)
- **AI Services:**
  - Claude (Anthropic) - Story text generation
  - Gemini (Google) - Image generation & photo analysis
- **Email:** Resend
- **Payments:** Stripe
- **Print:** Gelato
- **Hosting:** Railway

### Key Features
- Multi-language support (EN, DE, FR)
- Character photo upload and AI analysis
- Story generation with multiple art styles
- Sequential image generation for visual consistency
- Cover image generation (front, back, initial)
- PDF generation and print ordering
- User authentication (Firebase)
- Admin dashboard with developer mode

---

## Documentation by Category

### Core Documentation

| File | Description |
|------|-------------|
| **README.md** | Project overview, tech stack, quick start |
| **DEPLOYMENT_GUIDE.md** | Railway/Render deployment instructions |
| **EMAIL_SETUP_GUIDE.md** | Resend email setup and templates |

### Technical Documentation

| File | Description |
|------|-------------|
| **docs/PIPELINE_ANALYSIS.md** | Story generation job pipeline |
| **STORY-GENERATION-ANALYSIS.md** | Detailed generation analysis |
| **PIPELINE_OPTIMIZATIONS.md** | Performance optimization details |
| **PERFORMANCE_OPTIMIZATIONS.md** | System performance tuning |
| **IMPLEMENTATION_DIFFERENCES.md** | Client vs server implementation notes |
| **DATABASE_MIGRATION_SUMMARY.md** | PostgreSQL migration notes |

### Feature Documentation

| File | Description |
|------|-------------|
| **CHARAKTER-ERSTELLUNG.md** | Character creation feature (German) |
| **COVER_SYSTEM_IMPLEMENTATION_PLAN.md** | Cover generation system |

### Planning Documentation

| File | Description | Status |
|------|-------------|--------|
| **ADMIN_DASHBOARD.md** | Admin analytics dashboard design | Partially implemented |
| **STORAGE-PROPOSAL.md** | R2 object storage migration plan | Not implemented |
| **ToDo.md** | Current task list | Active |
| **requirements/** | Enterprise architecture specs | Future vision |

### Development Instructions

| File | Description |
|------|-------------|
| **CLAUDE.md** | Claude Code AI assistant instructions |

---

## Archived Documentation

Outdated files moved to `docs/archive/`:

| File | Reason Archived |
|------|-----------------|
| CHARACTER-CONSISTENCY-SYSTEM.md | iOS app architecture (Swift) - not applicable |
| DATABASE_SETUP.md | MySQL setup - we use PostgreSQL |
| DATABASE_TROUBLESHOOTING.md | MySQL troubleshooting |
| DEPLOY-CLOUDFLARE.md | Cloudflare Workers - we use Railway |
| DEPLOY.md | Old deployment notes |
| SERVER_SETUP.md | Old server setup |
| PROMPT-1-OUTLINE.md | Outdated line references |
| PROMPT-2-STORY-TEXT.md | Outdated line references |
| PROMPT-3-SCENE-DESCRIPTIONS.md | Outdated line references |
| PROMPT-4-IMAGE-GENERATION.md | Outdated line references |

---

## Server Configuration

### Environment Variables (Railway)

```env
# Database
DATABASE_URL=postgresql://...

# AI APIs
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...

# Authentication
JWT_SECRET=...
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}

# Email
RESEND_API_KEY=re_...
EMAIL_FROM=MagicalStory <noreply@magicalstory.ch>
ADMIN_EMAIL=admin@magicalstory.ch

# Payments
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Print
GELATO_API_KEY=...

# App
NODE_ENV=production
ADMIN_USER_IDS=1,2,3
```

---

## API Endpoints Summary

### Stories
- `POST /api/jobs/create-story` - Start story generation job
- `GET /api/jobs/:jobId/status` - Poll job status
- `GET /api/stories` - List user's stories
- `GET /api/stories/:id` - Get story details
- `DELETE /api/stories/:id` - Delete story

### Regeneration
- `POST /api/stories/:id/regenerate/scene-description/:pageNum` - Regenerate scene
- `POST /api/stories/:id/regenerate/image/:pageNum` - Regenerate image
- `POST /api/stories/:id/regenerate/cover/:coverType` - Regenerate cover
- `POST /api/stories/:id/edit/image/:pageNum` - Edit image with prompt
- `POST /api/stories/:id/edit/cover/:coverType` - Edit cover with prompt

### Admin
- `GET /api/admin/metrics/summary` - Dashboard metrics
- `GET /api/admin/users` - List all users
- `GET /api/admin/user-storage` - Storage usage per user
- `GET /api/admin/database-size` - Database statistics

### Payments
- `POST /api/stripe/create-checkout-session` - Create payment
- `GET /api/stripe/order-status/:sessionId` - Check order status
- `POST /api/print-provider/order` - Direct print order (dev mode)

---

## Development Workflow

### Local Development
```bash
# Install dependencies
npm install
cd client && npm install

# Start development servers
npm run dev          # Backend on port 3000
cd client && npm run dev  # Frontend on port 5173
```

### Deployment
```bash
# Push to main branch triggers Railway auto-deploy
git push origin master

# Or manual deploy
railway up
```

---

## Troubleshooting

### Common Issues

**Story generation fails:**
- Check Railway logs for error details
- Verify API keys are valid
- Check Gemini image generation limits

**Images not generating:**
- Gemini content safety filters may block certain prompts
- Check `finishReason` and `finishMessage` in logs
- Retry usually works

**Email not sending:**
- Verify Resend API key
- Check domain verification in Resend dashboard
- Check ADMIN_EMAIL env variable

---

## File Organization

```
MagicalStory/
├── client/                  # React frontend
│   ├── src/
│   │   ├── components/      # UI components
│   │   ├── pages/           # Page components
│   │   ├── services/        # API clients
│   │   ├── context/         # React contexts
│   │   └── types/           # TypeScript types
│   └── public/
├── server.js                # Express backend
├── email.js                 # Email utilities
├── prompts/                 # AI prompt templates
├── docs/                    # Documentation
│   ├── archive/             # Archived/obsolete docs
│   └── PIPELINE_ANALYSIS.md
├── requirements/            # Future architecture specs
├── DOCUMENTATION.md         # This file
├── README.md                # Project overview
└── *.md                     # Feature documentation
```

---

## External Service Integrations

### Firebase Authentication

**Purpose:** User authentication and session management

**Setup:**
1. Create Firebase project at console.firebase.google.com
2. Enable Email/Password authentication
3. Generate service account key (Project Settings → Service Accounts)
4. Base64 encode the JSON and set `FIREBASE_SERVICE_ACCOUNT`
5. Add your domain to authorized domains

**Client-side:** Uses Firebase SDK for login/signup flows
**Server-side:** Verifies tokens using Firebase Admin SDK

### Stripe Payments

**Purpose:** Payment processing for print book orders

**Endpoints:**
- `POST /api/stripe/create-checkout-session` - Creates Stripe checkout
- `POST /api/stripe/webhook` - Handles payment events
- `GET /api/stripe/order-status/:sessionId` - Checks payment status

**Webhook Events:**
- `checkout.session.completed` - Payment successful, triggers print order
- `payment_intent.succeeded` - Backup payment confirmation

**Setup:**
1. Create Stripe account at dashboard.stripe.com
2. Get API keys (Settings → API keys)
3. Create webhook endpoint pointing to `/api/stripe/webhook`
4. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`

### Gelato Print API

**Purpose:** Print-on-demand book fulfillment

**Flow:**
1. User completes Stripe payment
2. Server generates print-ready PDF
3. Server creates Gelato order via API
4. Gelato prints and ships book

**Products:**
- Hardcover photobook (28 pages minimum)
- A4 format

**Endpoints:**
- `POST /api/print-provider/order` - Create print order (dev mode: no payment required)

**Setup:**
1. Create Gelato account at gelato.com
2. Get API key from dashboard
3. Set `GELATO_API_KEY`

### Resend Email

**Purpose:** Transactional emails (story completion, order confirmation)

**Templates:**
- Story completion notification
- Order confirmation
- Admin notifications

**Setup:**
1. Create Resend account at resend.com
2. Verify your domain
3. Get API key
4. Set `RESEND_API_KEY` and `EMAIL_FROM`

See [EMAIL_SETUP_GUIDE.md](EMAIL_SETUP_GUIDE.md) for detailed configuration.

### Claude (Anthropic)

**Purpose:** AI text generation

**Used for:**
- Story outline generation
- Story text generation
- Scene descriptions
- Image quality evaluation

**Model:** claude-sonnet-4-20250514 (configurable)

**Setup:**
1. Get API key from console.anthropic.com
2. Set `ANTHROPIC_API_KEY`

### Gemini (Google AI)

**Purpose:** AI image generation and photo analysis

**Used for:**
- Character photo analysis (extract traits)
- Scene image generation
- Cover image generation
- Image quality scoring

**Models:**
- `gemini-2.5-flash-image` - Image generation
- `gemini-2.0-flash-exp-image-generation` - Image editing

**Setup:**
1. Get API key from ai.google.dev
2. Set `GEMINI_API_KEY`

---

## Support

- **GitHub Issues:** Report bugs and feature requests
- **Admin Dashboard:** Monitor system health at /admin
- **Railway Logs:** Debug production issues
