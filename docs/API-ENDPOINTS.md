# MagicalStory API Endpoints

**Last Updated:** January 2025

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Authentication](#2-authentication)
3. [User Management](#3-user-management)
4. [Characters](#4-characters)
5. [Avatars](#5-avatars)
6. [Stories](#6-stories)
7. [Story Jobs](#7-story-jobs)
8. [Regeneration & Editing](#8-regeneration--editing)
9. [Files](#9-files)
10. [Payments](#10-payments)
11. [Print & Orders](#11-print--orders)
12. [Admin](#12-admin)
13. [Webhooks](#13-webhooks)
14. [Utility](#14-utility)
15. [Architecture Issues](#15-architecture-issues)

---

## 1. Architecture Overview

### Route Organization

The API is split between:

1. **Modular Routes** (`server/routes/*.js`) - Extracted, organized by domain
2. **Legacy Routes** (`server.js`) - Still embedded in main file (~2000 lines)

```
server.js
├── Webhooks (Stripe, Gelato)
├── Regeneration endpoints
├── PDF generation
├── Payment endpoints
├── Story job management
└── Misc admin endpoints

server/routes/
├── auth.js           → /api/auth/*
├── user.js           → /api/user/*
├── characters.js     → /api/characters/*
├── avatars.js        → /api/* (analyze-photo, generate-*, avatar-*)
├── stories.js        → /api/stories/*
├── storyDraft.js     → /api/story-draft/*
├── files.js          → /api/files/*
├── config.js         → /api/config/*
├── health.js         → /api/health, /api/check-ip, /api/log-error
├── photos.js         → /api/photos/*
├── ai-proxy.js       → /api/claude, /api/gemini
└── admin/
    ├── users.js          → /api/admin/users/*
    ├── analytics.js      → /api/admin/stats, database-size, etc.
    ├── database.js       → /api/admin/cleanup-*, fix-*, migrate-*
    ├── orders.js         → /api/admin/orders/*
    └── print-products.js → /api/admin/print-products/*
```

### Authentication

Most endpoints require JWT authentication via `authenticateToken` middleware.

| Auth Type | Header | Description |
|-----------|--------|-------------|
| Required | `Authorization: Bearer <token>` | Most endpoints |
| Optional | Same, but continues if missing | File access |
| Admin | Token + `role === 'admin'` | Admin endpoints |

---

## 2. Authentication

**Base Path:** `/api/auth`
**File:** `server/routes/auth.js`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/register` | - | Create new account |
| POST | `/login` | - | Email/password login |
| POST | `/firebase` | - | Firebase token login |
| GET | `/me` | Required | Get current user |
| POST | `/refresh` | Required | Refresh JWT token |
| POST | `/logout` | Required | Logout (invalidate token) |
| POST | `/send-verification` | Required | Send email verification |
| GET | `/verify-email/:token` | - | Verify email address |
| GET | `/verification-status` | Required | Check verification status |
| POST | `/change-email` | Required | Change email address |
| POST | `/reset-password` | - | Request password reset |
| POST | `/reset-password/confirm` | - | Confirm password reset |
| POST | `/change-password` | Required | Change password |
| POST | `/photo-consent` | Required | Accept photo consent |

---

## 3. User Management

**Base Path:** `/api/user`
**File:** `server/routes/user.js`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/location` | - | Get user's country from IP |
| GET | `/quota` | Required | Get credits balance |
| GET | `/shipping-address` | Required | Get saved shipping address |
| PUT | `/shipping-address` | Required | Update shipping address |
| GET | `/orders` | Required | List user's orders |
| PUT | `/update-email` | Required | Update email address |

---

## 4. Characters

**Base Path:** `/api/characters`
**File:** `server/routes/characters.js`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | Required | List user's characters |
| POST | `/` | Required | Save/update characters (batch) |
| GET | `/:characterId/avatars` | Required | Get character's avatar data |
| GET | `/:characterId/full` | Required | Get full character data with avatars |
| DELETE | `/:characterId` | Required | Delete character |
| DELETE | `/avatars/styled` | Required | Clear styled avatar cache |

---

## 5. Avatars

**Base Path:** `/api`
**File:** `server/routes/avatars.js`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/analyze-photo` | Required | Analyze uploaded photo for traits |
| GET | `/avatar-prompt` | Required | Get avatar generation prompt |
| POST | `/generate-avatar-options` | Required | Generate avatar options (background job) |
| POST | `/generate-clothing-avatars` | Required | Generate seasonal clothing avatars |
| GET | `/avatar-jobs/:jobId` | Required | Check avatar job status |

---

## 6. Stories

**Base Path:** `/api/stories`
**File:** `server/routes/stories.js`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | Required | List user's stories |
| GET | `/:id` | Required | Get story details |
| POST | `/` | Required | Save new story |
| DELETE | `/:id` | Required | Delete story |
| GET | `/:id/metadata` | Required | Get story metadata |
| GET | `/:id/dev-metadata` | Required | Get developer metadata |
| GET | `/:id/image/:pageNumber` | Required | Get page image |
| GET | `/:id/cover-image/:coverType` | Required | Get cover image |
| GET | `/:id/cover` | Required | Get cover data |
| PATCH | `/:id/page/:pageNum` | Required | Edit page text/scene |
| PUT | `/:id/visual-bible` | Required | Update Visual Bible |
| PUT | `/:id/text` | Required | Update story text |
| PUT | `/:id/title` | Required | Update story title |
| PUT | `/:id/pages/:pageNumber/active-image` | Required | Set active image for page |
| GET | `/historical-events` | - | List historical events |
| GET | `/historical-events/:id` | - | Get historical event details |
| GET | `/debug/:id` | Required | Debug story data |

### Story Drafts

**Base Path:** `/api/story-draft`
**File:** `server/routes/storyDraft.js`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | Required | Get current draft |
| POST | `/` | Required | Save draft |
| DELETE | `/` | Required | Delete draft |

---

## 7. Story Jobs

**Base Path:** `/api/jobs` (in `server.js`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/create-story` | Required | Start story generation job |
| GET | `/:jobId/status` | Required | Poll job progress |
| POST | `/:jobId/cancel` | Required | Cancel running job |
| GET | `/my-jobs` | Required | List user's jobs |
| GET | `/:jobId/checkpoints` | Required | Get job checkpoints |
| GET | `/:jobId/checkpoints/:stepName` | Required | Get specific checkpoint |

---

## 8. Regeneration & Editing

**Base Path:** `/api/stories/:id` (in `server.js`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/regenerate/scene-description/:pageNum` | Required | Regenerate scene description |
| POST | `/regenerate/image/:pageNum` | Required | Regenerate page image |
| POST | `/regenerate/cover/:coverType` | Required | Regenerate cover image |
| POST | `/edit/image/:pageNum` | Required | Edit image with custom prompt |
| POST | `/edit/cover/:coverType` | Required | Edit cover with custom prompt |
| POST | `/repair/image/:pageNum` | Required | Auto-repair image issues |
| PATCH | `/page/:pageNum` | Required | Edit page text (DUPLICATE - see Stories) |

**Note:** `PATCH /:id/page/:pageNum` exists in BOTH `server.js` and `stories.js` - see [Architecture Issues](#15-architecture-issues).

---

## 9. Files

**Base Path:** `/api/files`
**File:** `server/routes/files.js`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/` | Required | Upload file |
| GET | `/:fileId` | Optional | Get file by ID |
| DELETE | `/:fileId` | Required | Delete file |

---

## 10. Payments

**Base Path:** `/api` (in `server.js`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/pricing` | - | Get pricing tiers |
| POST | `/stripe/create-checkout-session` | Required | Create Stripe checkout for print |
| POST | `/stripe/create-credits-checkout` | Required | Create Stripe checkout for credits |
| GET | `/stripe/order-status/:sessionId` | - | Check order status |

---

## 11. Print & Orders

**Base Path:** `/api` (in `server.js`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/print-provider/order` | Required | Create print order directly |
| GET | `/print-provider/products` | - | Get available print products |
| GET | `/stories/:id/pdf` | Required | Generate PDF for download |
| GET | `/stories/:id/print-pdf` | Required | Generate print-ready PDF |
| POST | `/generate-pdf` | Required | Generate PDF from data |
| POST | `/generate-book-pdf` | Required | Generate complete book PDF |

---

## 12. Admin

### Analytics & Stats

**Base Path:** `/api/admin`
**File:** `server/routes/admin/analytics.js`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/stats` | Admin | Get dashboard statistics |
| GET | `/database-size` | Admin | Get database storage metrics |
| GET | `/user-storage` | Admin | Get per-user storage usage |
| GET | `/config` | Admin | Get system configuration |
| GET | `/token-usage` | Admin | Get AI token usage stats |

### User Management

**Base Path:** `/api/admin/users`
**File:** `server/routes/admin/users.js`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | Admin | List all users |
| GET | `/:userId/details` | Admin | Get user details |
| GET | `/:userId/credits` | Admin | Get user credit history |
| GET | `/:userId/stories` | Admin | List user's stories |
| GET | `/:userId/stories/:storyId` | Admin | Get specific story |
| POST | `/:userId/quota` | Admin | Update user credits |
| POST | `/:userId/email-verified` | Admin | Set email verified status |
| POST | `/:userId/photo-consent` | Admin | Set photo consent status |
| DELETE | `/:userId` | Admin | Delete user |

### Impersonation

**Base Path:** `/api/admin`
**File:** `server/routes/admin.js`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/impersonate/:userId` | Admin | Impersonate user |
| POST | `/stop-impersonate` | Required | Stop impersonation |

### Orders

**Base Path:** `/api/admin/orders`
**File:** `server/routes/admin/orders.js`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | Admin | List all orders |

**In `server.js`:**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/admin/orders/:orderId/retry-print-order` | Admin | Retry failed print order |

### Print Products

**Base Path:** `/api/admin/print-products`
**File:** `server/routes/admin/print-products.js`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | Admin | List print products |
| POST | `/` | Admin | Create print product |
| PUT | `/:id` | Admin | Update print product |
| PUT | `/:id/toggle` | Admin | Toggle product active status |
| DELETE | `/:id` | Admin | Delete print product |

**In `server.js`:**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/admin/print-provider/fetch-products` | Admin | Fetch products from Gelato |
| GET | `/admin/print-provider/products` | Admin | List products (DUPLICATE) |
| POST | `/admin/print-provider/products` | Admin | Create product (DUPLICATE) |
| POST | `/admin/print-provider/seed-products` | Admin | Seed default products |

### Database Maintenance

**Base Path:** `/api/admin`
**File:** `server/routes/admin/database.js`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/fix-shipping-columns` | Admin | Fix shipping address columns |
| POST | `/cleanup-orphaned-data` | Admin | Clean orphaned story data |
| POST | `/cleanup-orphaned-jobs` | Admin | Clean orphaned job data |
| POST | `/cleanup-orphaned` | Admin | Clean all orphaned data |
| POST | `/clear-cache` | Admin | Clear server caches |
| DELETE | `/orphaned-files` | Admin | Delete orphaned files |
| POST | `/fix-metadata-migration` | Admin | Fix story metadata |
| POST | `/migrate-story-images/:storyId` | Admin | Migrate story images to files |
| POST | `/migrate-all-story-images` | Admin | Migrate all story images |
| POST | `/convert-characters-jsonb` | Admin | Convert characters to JSONB |

**In `server.js`:**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/admin/config` | Required | Update system config |
| DELETE | `/admin/landmarks-cache` | - | Clear landmarks cache |

---

## 13. Webhooks

**In `server.js`:**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/stripe/webhook` | Stripe Sig | Handle Stripe events |
| POST | `/gelato/webhook` | - | Handle Gelato events |

---

## 14. Utility

### Health & Config

**File:** `server/routes/health.js`, `server/routes/config.js`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/health` | - | Health check |
| GET | `/check-ip` | - | Get client IP |
| POST | `/log-error` | - | Log frontend errors |
| GET | `/config` | - | Get public config |
| GET | `/config/print-product-uid` | Required | Get print product UID |

### Photos

**File:** `server/routes/photos.js`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/photos/status` | - | Check photo service status |

### AI Proxy (Developer Mode)

**File:** `server/routes/ai-proxy.js`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/claude` | Required | Proxy Claude API calls |
| POST | `/gemini` | Required | Proxy Gemini API calls |

### Landmarks

**In `server.js`:**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/landmarks/discover` | - | Discover landmarks in image |

### Story Ideas

**In `server.js`:**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/generate-story-ideas` | Required | Generate story ideas |
| POST | `/generate-story-ideas-stream` | Required | Generate ideas (streaming) |

### Static

**In `server.js`:**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/robots.txt` | - | Robots file |
| GET | `/sitemap.xml` | - | Sitemap |
| GET | `*` | - | Serve frontend |

---

## 15. Architecture Issues

### Duplicated Endpoints

The following endpoints are defined in MULTIPLE locations:

#### 1. `PATCH /api/stories/:id/page/:pageNum`

| Location | Line | Notes |
|----------|------|-------|
| `server.js` | 3294 | Original location |
| `server/routes/stories.js` | 741 | Extracted copy |

**Impact:** Both are active. The `server.js` version is hit first due to route order.

**Recommendation:** Remove from `server.js`, keep only in `stories.js`.

#### 2. Print Products Admin Endpoints

| Endpoint | server.js | admin/print-products.js |
|----------|-----------|-------------------------|
| GET `/admin/print-provider/products` | Line 3799 | Line 24 (different path) |
| POST `/admin/print-provider/products` | Line 3832 | Line 41 (different path) |

**Note:** These use different paths (`/print-provider/` vs `/print-products/`) so both are accessible. The `server.js` versions are legacy.

**Recommendation:** Consolidate to single path, deprecate `/print-provider/` endpoints.

### Routes Still in server.js (~2000 lines)

These should be extracted to modular route files:

| Category | Endpoints | Lines | Recommended File |
|----------|-----------|-------|------------------|
| Webhooks | 2 | ~400 | `server/routes/webhooks.js` |
| Regeneration | 6 | ~800 | `server/routes/regeneration.js` |
| PDF Generation | 4 | ~700 | `server/routes/pdf.js` |
| Payments | 4 | ~300 | `server/routes/payments.js` |
| Story Jobs | 5 | ~500 | `server/routes/jobs.js` |
| Misc Admin | 5 | ~300 | Various admin files |

### Missing Route Files

The `avatarsRoutes` is mounted but not exported from index:

```javascript
// server.js:935
app.use('/api', avatarsRoutes);  // Loaded directly, not from index
```

**Recommendation:** Add to `server/routes/index.js` exports.

---

## Endpoint Count Summary

| Category | Count | Location |
|----------|-------|----------|
| Authentication | 14 | `auth.js` |
| User | 6 | `user.js` |
| Characters | 6 | `characters.js` |
| Avatars | 5 | `avatars.js` |
| Stories | 16 | `stories.js` |
| Story Drafts | 3 | `storyDraft.js` |
| Files | 3 | `files.js` |
| Admin Users | 10 | `admin/users.js` |
| Admin Analytics | 5 | `admin/analytics.js` |
| Admin Database | 10 | `admin/database.js` |
| Admin Print Products | 5 | `admin/print-products.js` |
| Admin Orders | 1 | `admin/orders.js` |
| Admin Other | 2 | `admin.js` |
| **In server.js** | | |
| Webhooks | 2 | `server.js` |
| Regeneration | 7 | `server.js` |
| PDF | 4 | `server.js` |
| Payments | 4 | `server.js` |
| Jobs | 6 | `server.js` |
| Print Provider | 6 | `server.js` |
| Misc | 8 | `server.js` |
| **Total** | **~123** | |

---

## Rate Limiting

| Limiter | Endpoints | Limit |
|---------|-----------|-------|
| `apiLimiter` | All `/api/*` | 100 req/15min |
| `authLimiter` | `/auth/login`, `/auth/firebase` | 5 req/15min |
| `registerLimiter` | `/auth/register` | 3 req/hour |
| `passwordResetLimiter` | `/auth/reset-password/*` | 3 req/hour |
| `storyGenerationLimiter` | `/jobs/create-story` | 10 req/hour |
| `imageRegenerationLimiter` | All regeneration endpoints | 30 req/15min |
| `aiProxyLimiter` | `/claude`, `/gemini` | 20 req/min |
| `errorLoggingLimiter` | `/log-error` | 10 req/min |
