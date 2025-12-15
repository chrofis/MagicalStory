# MagicalStory - Deployment Guide

This guide shows how to deploy MagicalStory to Railway (recommended).

## Prerequisites

- GitHub account with MagicalStory repository
- Railway account (https://railway.app/)
- Required API keys:
  - Anthropic (Claude) API key
  - Google AI (Gemini) API key
  - Firebase service account (for authentication)
  - Resend API key (for emails)
  - Stripe keys (for payments)
  - Gelato API key (for print orders)

---

## Deploy to Railway (Recommended)

### Step 1: Connect Repository

1. Go to https://railway.app/
2. Sign up/login with GitHub
3. Click "New Project" → "Deploy from GitHub repo"
4. Select your MagicalStory repository
5. Railway auto-detects Node.js and starts deployment

### Step 2: Add PostgreSQL Database

1. In Railway dashboard, click "+ New"
2. Select "Database" → "PostgreSQL"
3. Railway automatically sets `DATABASE_URL` environment variable

### Step 3: Configure Environment Variables

In Railway dashboard → Variables tab, add:

```env
# Database (auto-set by Railway PostgreSQL)
DATABASE_URL=postgresql://...

# AI APIs
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...

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

### Step 4: Custom Domain (Optional)

1. In Railway dashboard → Settings → Domains
2. Add custom domain (e.g., magicalstory.ch)
3. Configure DNS at your registrar:
   - CNAME record pointing to Railway URL

### Step 5: Verify Deployment

1. Check deployment logs in Railway dashboard
2. Visit your Railway URL or custom domain
3. Test user registration and story generation

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `ANTHROPIC_API_KEY` | Yes | Claude API for story generation |
| `GEMINI_API_KEY` | Yes | Gemini API for image generation |
| `FIREBASE_SERVICE_ACCOUNT` | Yes | Base64-encoded Firebase service account JSON |
| `JWT_SECRET` | Yes | Secret for JWT token signing |
| `RESEND_API_KEY` | Yes | Resend API for transactional emails |
| `EMAIL_FROM` | Yes | From address for emails |
| `ADMIN_EMAIL` | No | Admin notification email |
| `STRIPE_SECRET_KEY` | Yes | Stripe secret key for payments |
| `STRIPE_WEBHOOK_SECRET` | Yes | Stripe webhook signing secret |
| `GELATO_API_KEY` | Yes | Gelato API for print orders |
| `NODE_ENV` | No | Set to "production" |
| `ADMIN_USER_IDS` | No | Comma-separated user IDs with admin access |

---

## Firebase Setup

### Create Service Account

1. Go to Firebase Console → Project Settings → Service Accounts
2. Click "Generate new private key"
3. Download JSON file
4. Base64 encode the JSON:
   ```bash
   base64 -i service-account.json
   ```
5. Set `FIREBASE_SERVICE_ACCOUNT` to the base64 string

### Configure Authentication

1. Enable Email/Password authentication in Firebase Console
2. Add your domain to authorized domains

---

## Stripe Setup

### Configure Webhook

1. In Stripe Dashboard → Developers → Webhooks
2. Add endpoint: `https://your-domain.com/api/stripe/webhook`
3. Select events:
   - `checkout.session.completed`
   - `payment_intent.succeeded`
4. Copy webhook signing secret to `STRIPE_WEBHOOK_SECRET`

---

## Troubleshooting

### Common Issues

**Build fails:**
- Check Railway logs for error details
- Verify all dependencies in package.json
- Ensure client build succeeds (`cd client && npm run build`)

**Database connection errors:**
- Verify DATABASE_URL is set correctly
- Check PostgreSQL service is running in Railway

**Authentication fails:**
- Verify FIREBASE_SERVICE_ACCOUNT is valid base64
- Check JWT_SECRET is set
- Ensure Firebase project settings match

**Images not generating:**
- Check GEMINI_API_KEY is valid
- Review logs for Gemini API errors
- Check for content safety filter blocks

**Emails not sending:**
- Verify RESEND_API_KEY is valid
- Check domain verification in Resend dashboard
- Review email logs in Resend dashboard

### View Logs

```bash
# Railway CLI
railway logs

# Or in Railway dashboard → Deployments → View Logs
```

---

## Updating the App

Railway auto-deploys on push to main branch:

```bash
git add .
git commit -m "Your changes"
git push origin master
```

Or manual deploy:
```bash
railway up
```

---

## Production Checklist

- [x] PostgreSQL database provisioned
- [x] All environment variables configured
- [x] Firebase authentication working
- [x] Story generation working (Claude + Gemini)
- [x] Email notifications working (Resend)
- [x] Payment processing working (Stripe)
- [x] Print ordering working (Gelato)
- [x] Custom domain configured (optional)
- [x] SSL/HTTPS enabled (automatic on Railway)
