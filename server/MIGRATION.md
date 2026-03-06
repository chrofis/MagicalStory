# Server Architecture Migration Guide

## Current State

The server has been restructured from a single 15,000-line `server.js` file into a modular architecture. Many routes have been migrated to the new structure.

### Migrated Routes ✅

| Route | File | Lines | Status |
|-------|------|-------|--------|
| `/api/config/*` | `routes/config.js` | ~35 | ✅ Migrated |
| `/api/health`, `/api/check-ip`, `/api/log-error` | `routes/health.js` | ~55 | ✅ Migrated |
| `/api/auth/*` | `routes/auth.js` | ~600 | ✅ Migrated |
| `/api/user/*` | `routes/user.js` | ~260 | ✅ Migrated |
| `/api/characters/*` | `routes/characters.js` | ~110 | ✅ Migrated |
| `/api/story-draft` | `routes/storyDraft.js` | ~100 | ✅ Migrated |
| `/api/stories/*` (CRUD) | `routes/stories.js` | ~350 | ✅ Migrated |
| `/api/files/*` | `routes/files.js` | ~160 | ✅ Migrated |
| `/api/admin/*` | `routes/admin.js` | ~1600 | ✅ Migrated |

### Routes Remaining in server.js (Complex Dependencies)

| Route | Reason |
|-------|--------|
| `/api/stories/:id/regenerate/*` | AI generation dependencies |
| `/api/stories/:id/edit/*` | AI generation dependencies |
| `/api/stories/:id/pdf` | PDF generation with puppeteer |
| `/api/stripe/*` | Stripe SDK, processBookOrder, email |
| `/api/jobs/*` | Story generation, background processing |
| `/api/print-provider/*` | Gelato API integration |
| `/api/analyze-photo` | AI vision analysis |
| `/api/generate-clothing-avatars` | AI avatar generation |
| `/api/claude`, `/api/gemini` | AI API proxies |

These routes have tight coupling with:
- AI generation functions (callClaudeAPI, callGeminiAPIForImage)
- Background job processing (processStoryJob)
- Stripe SDK initialization (stripeTest, stripeLive)
- Email service functions
- PDF generation with puppeteer

A future phase should extract these into services.

## New Structure

```
server/
├── index.js              # New modular entry point ✅
├── MIGRATION.md          # This file
├── routes/
│   ├── index.js          # Route exports ✅
│   ├── auth.js           # /api/auth/* ✅
│   ├── config.js         # /api/config/* ✅
│   ├── health.js         # /api/health, check-ip, log-error ✅
│   ├── user.js           # /api/user/* ✅
│   ├── characters.js     # /api/characters/* ✅
│   ├── stories.js        # /api/stories/* (CRUD) ✅
│   ├── storyDraft.js     # /api/story-draft ✅
│   ├── files.js          # /api/files/* ✅
│   └── admin.js          # /api/admin/* ✅
├── services/
│   ├── index.js          # Service exports ✅
│   ├── database.js       # Database connection & queries ✅
│   ├── storyGenerator.js # Story generation logic (to create)
│   ├── imageGenerator.js # Image generation with Gemini (to create)
│   ├── textGenerator.js  # Text generation with Claude/Gemini (to create)
│   ├── pdfGenerator.js   # PDF generation (to create)
│   ├── stripeService.js  # Stripe payment processing (to create)
│   └── gelatoService.js  # Gelato print integration (to create)
├── middleware/
│   ├── index.js          # Middleware exports ✅
│   ├── auth.js           # JWT authentication ✅
│   └── rateLimit.js      # Rate limiting ✅
└── utils/
    ├── index.js          # Utils exports ✅
    ├── logger.js         # Logging utility ✅
    └── config.js         # Configuration & constants ✅
```

## How to Migrate a Route

### Step 1: Create the Route File

```javascript
// server/routes/stories.js
const express = require('express');
const router = express.Router();

const { dbQuery } = require('../services/database');
const { authenticateToken } = require('../middleware/auth');
const { log } = require('../utils/logger');

// GET /api/stories
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const stories = await dbQuery(
      'SELECT id, data FROM stories WHERE user_id = $1',
      [userId]
    );
    res.json(stories);
  } catch (err) {
    log.error('Failed to fetch stories:', err);
    res.status(500).json({ error: 'Failed to fetch stories' });
  }
});

module.exports = router;
```

### Step 2: Import in server/index.js

```javascript
// In server/index.js
const storyRoutes = require('./routes/stories');
app.use('/api/stories', storyRoutes);
```

### Step 3: Remove from server.js

Delete or comment out the corresponding routes in the legacy `server.js`.

### Step 4: Test

Run the app and verify the routes work correctly.

## Migration Priority

Migration order (completed items marked):

1. ✅ **Config routes** (`/api/config/*`) - Simple, few dependencies
2. ✅ **Health/Utility routes** (`/api/health`, `/api/check-ip`) - Simple
3. ✅ **User routes** (`/api/user/*`) - Moderate complexity
4. ✅ **Character routes** (`/api/characters/*`) - Moderate complexity
5. ✅ **Auth routes** (`/api/auth/*`) - Complex but self-contained
6. ✅ **Story routes** (`/api/stories/*`) - CRUD operations migrated
7. ✅ **Story draft routes** (`/api/story-draft`) - Step 1 & 4 data persistence
8. ✅ **Files routes** (`/api/files/*`) - File upload/download
9. ✅ **Admin routes** (`/api/admin/*`) - Complex, admin-only
10. ⏸️ **Payment routes** (`/api/stripe/*`) - Deferred (Stripe SDK dependencies)
11. ⏸️ **Job routes** (`/api/jobs/*`) - Deferred (AI generation dependencies)
12. ⏸️ **Story AI routes** (`regenerate/*`, `edit/*`) - Deferred (AI dependencies)
13. ⏸️ **Print routes** (`/api/print-provider/*`) - Deferred (Gelato integration)

## Services to Extract

Large functions that should become services:

| Function | New Location | Lines |
|----------|-------------|-------|
| `processStoryJob` | `services/storyGenerator.js` | ~1500 |
| `callGeminiAPIForImage` | `services/imageGenerator.js` | ~300 |
| `callAnthropicAPI` | `services/textGenerator.js` | ~200 |
| `generatePrintPdf` | `services/pdfGenerator.js` | ~400 |
| `processBookOrder` | `services/stripeService.js` | ~300 |

## Benefits After Migration

- **Smaller files**: Each file focuses on one concern
- **Fewer merge conflicts**: Different developers can work on different route files
- **Easier testing**: Can unit test individual modules
- **Better discoverability**: Clear file structure shows what's where
- **Faster development**: Find code faster, understand context quickly

## Keeping server.js Running

During migration, `server.js` continues to work. Routes are removed from it as they're migrated. Once fully migrated, `server.js` can be deleted and `server/index.js` becomes the entry point.

To test the new structure:
```bash
node server/index.js
```

To continue using the legacy server:
```bash
node server.js
```
