# MagicalStory Architecture & Deployment

**Last Updated:** January 2025

## Table of Contents

1. [Tech Stack](#1-tech-stack)
2. [Architecture Overview](#2-architecture-overview)
3. [File Organization](#3-file-organization)
4. [Environment Variables](#4-environment-variables)
5. [Database](#5-database)
6. [API Endpoints](#6-api-endpoints)
7. [External Service Integrations](#7-external-service-integrations)
8. [Deployment](#8-deployment)
9. [Development](#9-development)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Tech Stack

| Component | Technology |
|-----------|------------|
| **Frontend** | React 18 + Vite + TypeScript + Tailwind CSS |
| **Backend** | Node.js + Express.js |
| **Database** | PostgreSQL (Railway) |
| **AI Text** | Claude (Anthropic) - Story generation |
| **AI Images** | Gemini (Google) - Image generation & photo analysis |
| **Cheap Images** | Runware - Dev mode, inpainting (SDXL $0.002/img) |
| **Auth** | Firebase Authentication |
| **Email** | Resend |
| **Payments** | Stripe |
| **Print** | Gelato |
| **Hosting** | Railway |

---

## 2. Architecture Overview

### Story Generation Pipeline

```
POST /api/jobs/create-story → Background Job:
  1. Generate Outline (Claude)
  2. Extract Scene Hints
  3. Generate Story Text (Claude, batched)
  4. Generate Scene Descriptions (Claude, parallel)
  5. Generate Images (Gemini, parallel/sequential)
  6. Quality Evaluation + Auto-Repair (optional)
  7. Generate Covers (front, back, dedication)
  → GET /api/jobs/:id/status (polling)
```

### Key Backend Files

| File | Purpose |
|------|---------|
| `server.js` | Main Express app with embedded routes |
| `server/config/models.js` | AI model configuration and defaults |
| `server/lib/images.js` | Image generation, quality eval, inpainting |
| `server/lib/runware.js` | Runware API (FLUX, ACE++, inpainting) |
| `server/lib/textModels.js` | Claude/Gemini text generation |
| `server/lib/visualBible.js` | Character consistency tracking |
| `server/routes/avatars.js` | Avatar generation endpoints |
| `server/routes/stories.js` | Story CRUD and regeneration |
| `prompts/` | AI prompt templates |

### Key Frontend Files

| File | Purpose |
|------|---------|
| `client/src/pages/StoryWizard.tsx` | Main story creation wizard |
| `client/src/hooks/useDeveloperMode.ts` | Dev mode model overrides |
| `client/src/types/character.ts` | Character type definitions |
| `client/src/components/generation/` | Story generation UI |

---

## 3. File Organization

```
MagicalStory/
├── client/                  # React frontend
│   ├── src/
│   │   ├── components/      # UI components
│   │   │   ├── auth/        # Auth components
│   │   │   ├── character/   # Character form components
│   │   │   ├── common/      # Shared UI components
│   │   │   ├── generation/  # Story generation UI
│   │   │   └── story/       # Story wizard steps
│   │   ├── pages/           # Page components
│   │   ├── services/        # API clients
│   │   ├── context/         # React contexts
│   │   ├── hooks/           # Custom hooks
│   │   └── types/           # TypeScript types
│   └── public/
├── server/                  # Backend modules
│   ├── config/              # Configuration
│   ├── lib/                 # Core libraries
│   ├── middleware/          # Express middleware
│   ├── routes/              # API routes
│   └── services/            # Business logic
├── server.js                # Express backend entry
├── email.js                 # Email utilities
├── prompts/                 # AI prompt templates
├── docs/                    # Documentation
├── database/                # Migrations
└── scripts/                 # Utility scripts
```

---

## 4. Environment Variables

### Required Variables

```env
# Database (auto-set by Railway PostgreSQL)
DATABASE_URL=postgresql://...

# AI APIs
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
RUNWARE_API_KEY=...

# Authentication (Firebase service account JSON, base64 encoded)
FIREBASE_SERVICE_ACCOUNT=eyJ0eXBlIjoic2VydmljZV9hY2NvdW50Ii...
JWT_SECRET=your-secure-random-string

# Email (Resend)
RESEND_API_KEY=re_...
EMAIL_FROM=MagicalStory <noreply@magicalstory.ch>
ADMIN_EMAIL=admin@magicalstory.ch

# Payments (Stripe)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Print (Gelato)
GELATO_API_KEY=...

# App Settings
NODE_ENV=production
ADMIN_USER_IDS=1,2,3
```

### Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `ANTHROPIC_API_KEY` | Yes | Claude API for story generation |
| `GEMINI_API_KEY` | Yes | Gemini API for image generation |
| `RUNWARE_API_KEY` | No | Runware for dev mode/inpainting |
| `FIREBASE_SERVICE_ACCOUNT` | Yes | Base64-encoded Firebase service account JSON |
| `JWT_SECRET` | Yes | Secret for JWT token signing |
| `RESEND_API_KEY` | Yes | Resend API for emails |
| `EMAIL_FROM` | Yes | From address for emails |
| `ADMIN_EMAIL` | No | Admin notification email |
| `STRIPE_SECRET_KEY` | Yes | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Yes | Stripe webhook signing secret |
| `GELATO_API_KEY` | Yes | Gelato API for print orders |
| `NODE_ENV` | No | Set to "production" |
| `ADMIN_USER_IDS` | No | Comma-separated admin user IDs |

---

## 5. Database

### PostgreSQL on Railway

- **Connection:** `postgresql://postgres:***@postgres.railway.internal:5432/railway`
- **Mode:** `STORAGE_MODE=database`
- **Migrations:** Automatically run on server startup from `database/migrations/`

### Key Tables

| Table | Purpose |
|-------|---------|
| `users` | User accounts, credits, preferences |
| `characters` | Character data (JSONB) |
| `stories` | Generated stories with pages |
| `story_jobs` | Background job tracking |
| `orders` | Print orders |
| `config` | System configuration |
| `gelato_products` | Print product configuration |

### Migrations

Migrations are in `database/migrations/` and run sequentially on startup:
- `001_initial_schema.sql`
- `002_add_story_jobs.sql`
- ... etc.

---

## 6. API Endpoints

### Stories

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/jobs/create-story` | POST | Start story generation job |
| `/api/jobs/:jobId/status` | GET | Poll job status |
| `/api/jobs/:jobId/cancel` | POST | Cancel job |
| `/api/stories` | GET | List user's stories |
| `/api/stories/:id` | GET | Get story details |
| `/api/stories/:id` | DELETE | Delete story |

### Regeneration

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/stories/:id/regenerate/scene-description/:pageNum` | POST | Regenerate scene |
| `/api/stories/:id/regenerate/image/:pageNum` | POST | Regenerate image |
| `/api/stories/:id/regenerate/cover/:coverType` | POST | Regenerate cover |
| `/api/stories/:id/edit/image/:pageNum` | POST | Edit image with prompt |
| `/api/stories/:id/edit/cover/:coverType` | POST | Edit cover with prompt |

### Characters

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/characters` | GET | Get user's characters |
| `/api/characters` | POST | Save characters |
| `/api/characters/analyze` | POST | Analyze photo |
| `/api/avatars/generate` | POST | Generate avatar |

### Admin

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/metrics/summary` | GET | Dashboard metrics |
| `/api/admin/users` | GET | List all users |
| `/api/admin/user-storage` | GET | Storage usage |

### Payments

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/stripe/create-checkout-session` | POST | Create payment |
| `/api/stripe/webhook` | POST | Stripe webhooks |
| `/api/pricing` | GET | Get pricing tiers |

---

## 7. External Service Integrations

### Firebase Authentication

**Setup:**
1. Create Firebase project at console.firebase.google.com
2. Enable Email/Password authentication
3. Generate service account key (Project Settings → Service Accounts)
4. Base64 encode: `base64 -i service-account.json`
5. Set `FIREBASE_SERVICE_ACCOUNT` environment variable
6. Add your domain to authorized domains

### Stripe Payments

**Setup:**
1. Create Stripe account at dashboard.stripe.com
2. Get API keys (Settings → API keys)
3. Create webhook endpoint: `https://your-domain.com/api/stripe/webhook`
4. Select events: `checkout.session.completed`, `payment_intent.succeeded`
5. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`

### Gelato Print API

**Flow:**
1. User completes Stripe payment
2. Server generates print-ready PDF
3. Server creates Gelato order via API
4. Gelato prints and ships book

**Setup:**
1. Create Gelato account at gelato.com
2. Get API key from dashboard
3. Set `GELATO_API_KEY`

### Resend Email

**Setup:**
1. Create Resend account at resend.com
2. Verify your domain
3. Get API key
4. Set `RESEND_API_KEY` and `EMAIL_FROM`

**Templates:** Located in `emails/*.html`

### Claude (Anthropic)

**Used for:** Story outline, text generation, scene descriptions, quality evaluation

**Setup:**
1. Get API key from console.anthropic.com
2. Set `ANTHROPIC_API_KEY`

### Gemini (Google AI)

**Used for:** Character photo analysis, scene images, cover images, quality scoring

**Models:**
- `gemini-2.5-flash-preview-05-20` - Image generation
- Spatial reasoning for quality evaluation

**Setup:**
1. Get API key from ai.google.dev
2. Set `GEMINI_API_KEY`

### Runware

**Used for:** Dev mode cheap images, inpainting, ACE++ avatars

**Setup:**
1. Get API key from runware.ai
2. Set `RUNWARE_API_KEY`

---

## 8. Deployment

### Deploy to Railway (Recommended)

**Step 1: Connect Repository**
1. Go to https://railway.app/
2. Sign up/login with GitHub
3. Click "New Project" → "Deploy from GitHub repo"
4. Select MagicalStory repository
5. Railway auto-detects Node.js

**Step 2: Add PostgreSQL Database**
1. Click "+ New" → "Database" → "PostgreSQL"
2. Railway automatically sets `DATABASE_URL`

**Step 3: Configure Environment Variables**
Add all required variables in Railway dashboard → Variables tab

**Step 4: Custom Domain (Optional)**
1. Settings → Domains
2. Add custom domain
3. Configure DNS CNAME at your registrar

### Manual Deployment

```bash
# Push to master triggers auto-deploy
git push origin master

# Or manual deploy with Railway CLI
railway up
```

### Production Checklist

- [x] PostgreSQL database provisioned
- [x] All environment variables configured
- [x] Firebase authentication working
- [x] Story generation working
- [x] Email notifications working
- [x] Payment processing working
- [x] Print ordering working
- [x] SSL/HTTPS enabled (automatic on Railway)

---

## 9. Development

### Local Development

```bash
# Install all dependencies
npm install && cd client && npm install && cd ..

# Development (two terminals)
npm run dev                    # Backend on :3000
cd client && npm run dev       # Frontend on :5173

# Build frontend for production
cd client && npm run build     # Outputs to /dist
```

### Model Configuration

Models configured in `server/config/models.js`. Frontend can override via developer mode.

**Important notes:**
- `gemini-2.5-flash` required for quality evaluation (spatial reasoning)
- Runware has 3000 char prompt limit (vs 30000 for Gemini)
- ACE++ uses `referenceImages` at root level

### Prompt Templates

All prompts in `/prompts/*.txt`, loaded via `server/services/prompts.js`:

| File | Purpose |
|------|---------|
| `avatar-main-prompt.txt` | Gemini avatar generation |
| `avatar-ace-prompt.txt` | Runware ACE++ avatars |
| `image-generation.txt` | Scene illustrations |
| `image-evaluation.txt` | Quality evaluation |
| `outline.txt` | Story outline |
| `story-text-batch.txt` | Story text |
| `scene-descriptions.txt` | Scene descriptions |

---

## 10. Troubleshooting

### Common Issues

**Story generation fails:**
- Check Railway logs for error details
- Verify API keys are valid
- Check Gemini image generation limits

**Images not generating:**
- Gemini content safety filters may block prompts
- Check `finishReason` and `finishMessage` in logs
- Retry usually works

**Email not sending:**
- Verify Resend API key
- Check domain verification in Resend dashboard
- Check ADMIN_EMAIL env variable

**Build fails:**
- Check Railway logs
- Verify all dependencies in package.json
- Ensure client build succeeds

**Database connection errors:**
- Verify DATABASE_URL is correct
- Check PostgreSQL service is running

### View Logs

```bash
# Railway CLI
railway logs

# Or in Railway dashboard → Deployments → View Logs
```
