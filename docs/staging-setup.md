# Staging Environment Setup

15-20 minute one-time setup. Once done, production gets a buffer: code merges to `staging` → auto-deploys to staging.magicalstory.ch → you smoke-test → merge `staging` → `master` → auto-deploys to prod.

## Branch flow (already prepared)

```
feature/X branch
       ↓ merge
   staging          → auto-deploys to staging.magicalstory.ch
       ↓ merge after testing
   master           → auto-deploys to magicalstory.ch (prod)
```

The `staging` branch already exists on origin (created when this doc was written).

## Step 1 — Railway: new environment for staging

Railway has a built-in "Environments" feature that forks a project's resources.

1. Open Railway dashboard → MagicalStory project.
2. Top-right environment dropdown → **+ New Environment**.
3. Name: `staging`. Fork from `production`. **Don't** check "Copy environment variables yet" (we'll override them deliberately).
4. In the new staging environment, find the Node service.
5. Settings → **Source** → change deploy branch from `master` to `staging`. Enable auto-deploy.
6. Settings → **Domains** → add a new custom domain: `staging.magicalstory.ch`. Railway gives you a CNAME target (copy it for step 3).

## Step 2 — Railway: staging Postgres

In the staging environment:

1. **+ New** → **Database** → **PostgreSQL**.
2. Once provisioned, copy its `DATABASE_URL` from the Connect tab.
3. **Important**: this is a fresh empty DB. Migrations run on deploy (or run `npm run seed:staging` later — see Step 7).

## Step 3 — Cloudflare DNS: `staging.magicalstory.ch`

1. Cloudflare dashboard → `magicalstory.ch` zone → DNS → Records.
2. Add CNAME: name `staging`, target the value from Railway (Step 1.6).
3. Proxy status: **Proxied** (orange cloud).
4. TTL: Auto.

Wait 1-2 min for DNS to propagate. `dig staging.magicalstory.ch` should resolve.

## Step 4 — Cloudflare R2: staging bucket

R2 has a 10GB free tier — fits a lot of staging.

1. Cloudflare → R2 → Create bucket: `magicalstory-staging`.
2. Settings → Public access → Allow Access via custom domain or use the default R2.dev subdomain (R2.dev is fine for staging).
3. Manage API tokens → Create token: name `magicalstory-staging`, permission `Object Read & Write`, bucket `magicalstory-staging`.
4. Note the Access Key ID, Secret Access Key, and the bucket's public URL.

## Step 5 — Stripe: test mode keys

You already have a Stripe test mode key from `.env` (server.js reads `STRIPE_TEST_SECRET_KEY`). Reuse it for staging — no new account needed.

1. Stripe Dashboard → toggle **Test mode** (top right) → Developers → API keys → reveal `sk_test_…` (this is `STRIPE_TEST_SECRET_KEY`).
2. Developers → Webhooks → Add endpoint:
   - URL: `https://staging.magicalstory.ch/api/stripe/webhook`
   - Events: same selection as your prod webhook (checkout.session.completed at minimum).
   - Copy the signing secret as `STRIPE_TEST_WEBHOOK_SECRET`.

## Step 6 — Set staging env vars in Railway

Back in Railway → staging environment → Node service → **Variables**. Add (copy values where noted):

```
# Database
DATABASE_URL=<from Step 2>

# Storage / R2
R2_ACCOUNT_ID=<your Cloudflare account ID>
R2_ACCESS_KEY_ID=<from Step 4.3>
R2_SECRET_ACCESS_KEY=<from Step 4.3>
R2_BUCKET=magicalstory-staging
R2_PUBLIC_URL=<from Step 4.4>

# Stripe (TEST mode for staging)
STRIPE_TEST_SECRET_KEY=<from Step 5.1>
STRIPE_TEST_WEBHOOK_SECRET=<from Step 5.2>
# Leave STRIPE_LIVE_* unset on staging so test mode is forced

# URLs
FRONTEND_URL=https://staging.magicalstory.ch
BASE_URL=https://staging.magicalstory.ch
CORS_ORIGINS=https://staging.magicalstory.ch
NODE_ENV=staging

# OAuth — register a new staging redirect URI in Google Cloud Console:
# Authorized redirect URIs → add https://staging.magicalstory.ch/api/auth/google/callback
# Then reuse the same client ID/secret (or make a new pair if you prefer isolation)
GOOGLE_OAUTH_CLIENT_ID=<existing or new>
GOOGLE_OAUTH_CLIENT_SECRET=<existing or new>

# JWT — fresh secret for staging (don't share with prod):
JWT_SECRET=<generate: openssl rand -hex 64>

# AI providers — same keys are fine to share (rate limits are per-key):
ANTHROPIC_API_KEY=<copy from prod>
GEMINI_API_KEY=<copy from prod>
XAI_API_KEY=<copy from prod>
RUNWARE_API_KEY=<copy from prod>

# Photo analyzer — staging can point at prod's Python service (read-only operations):
PHOTO_ANALYZER_URL=<copy from prod>

# Admin — different secret for staging:
ADMIN_SECRET=<generate: openssl rand -hex 32>

# Email — Resend/SendGrid: either reuse with a verified test sender,
# or set EMAIL_DISABLED=true on staging to skip sending entirely
EMAIL_DISABLED=true

# Turnstile (Cloudflare bot protection) — staging key from Cloudflare dashboard:
TURNSTILE_SECRET_KEY=<staging key>

# Gelato (print on demand) — keep unset on staging, print orders test on prod
# GELATO_API_KEY=
# GELATO_PHOTOBOOK_UID=
# GELATO_WEBHOOK_SECRET=
```

## Step 7 — Seed staging with realistic data (optional)

Once the staging Postgres is up:

```bash
# From your local machine
node scripts/admin/seed-staging.js \
  --source=$DATABASE_URL_PROD \
  --target=$DATABASE_URL_STAGING \
  --max-users=5 \
  --sanitize
```

The script (`scripts/admin/seed-staging.js`):
- Copies up to N users from prod with their characters and stories.
- Replaces emails with `staging-user-N@test.magicalstory.ch`.
- Strips Stripe customer IDs and referral codes (no real billing on staging).
- Strips email verification tokens.
- Sets all users' credits to 100 for easy testing.

Skip this step if you'd rather start with an empty staging DB and create test stories from scratch.

## Step 8 — First staging deploy

```bash
# From local, master is up to date
git checkout staging
git pull origin staging   # in case anything's drifted
git merge master           # bring latest prod code to staging
git push origin staging    # triggers Railway auto-deploy
```

Wait ~5 min, then verify:
- `https://staging.magicalstory.ch` loads
- `https://staging.magicalstory.ch/api/health` returns 200
- Create a test account, generate a tiny story (10 pages, dev mode skip-images), confirm DB is staging not prod (check `users` count — should be ≤5 from seed)

## Daily workflow after setup

```bash
# Start a feature
git checkout -b fix/some-bug
# ... work ...
git push origin fix/some-bug
# Open PR against staging

# After review/merge, staging auto-deploys
# Smoke-test on https://staging.magicalstory.ch

# Once happy, promote to prod
git checkout master
git merge staging
git push origin master   # prod auto-deploys
```

For hotfixes that skip staging: still possible (push directly to master) but should be the exception.

## Cost estimate

Roughly **+$5-10/month** on Railway:
- Staging Node service: $5/mo (Hobby plan covers it)
- Staging Postgres: $5/mo
- Cloudflare R2: free (10GB tier)
- Cloudflare DNS: free
- Stripe test mode: free
- All other API providers: free (same keys, same quotas)

## Tearing it down

If you ever want to dismantle staging: Railway → environments → staging → Settings → Delete environment. Removes the service + Postgres. R2 bucket needs to be deleted separately in Cloudflare.
