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

## Support

- **GitHub Issues:** Report bugs and feature requests
- **Admin Dashboard:** Monitor system health at /admin
- **Railway Logs:** Debug production issues
