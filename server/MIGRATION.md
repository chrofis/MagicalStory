# Server Architecture Migration Guide

## Current State

The server has been restructured from a single 15,000-line `server.js` file into a modular architecture. Currently, `server.js` still contains all the route handlers, but the foundation for modular code is in place.

## New Structure

```
server/
├── index.js              # New modular entry point
├── MIGRATION.md          # This file
├── routes/
│   ├── index.js          # Route exports
│   ├── auth.js           # /api/auth/* (template)
│   ├── stories.js        # /api/stories/* (to create)
│   ├── characters.js     # /api/characters/* (to create)
│   ├── admin.js          # /api/admin/* (to create)
│   ├── payments.js       # /api/stripe/* (to create)
│   ├── print.js          # /api/print-provider/* (to create)
│   ├── files.js          # /api/files/* (to create)
│   ├── jobs.js           # /api/jobs/* (to create)
│   ├── user.js           # /api/user/* (to create)
│   └── config.js         # /api/config/* (to create)
├── services/
│   ├── index.js          # Service exports
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

Recommended order for migration:

1. **Config routes** (`/api/config/*`) - Simple, few dependencies
2. **Health/Utility routes** (`/api/health`, `/api/check-ip`) - Simple
3. **User routes** (`/api/user/*`) - Moderate complexity
4. **Character routes** (`/api/characters/*`) - Moderate complexity
5. **Auth routes** (`/api/auth/*`) - Complex but self-contained
6. **Story routes** (`/api/stories/*`) - Complex, many dependencies
7. **Admin routes** (`/api/admin/*`) - Complex, admin-only
8. **Payment routes** (`/api/stripe/*`) - Critical, test carefully
9. **Print routes** (`/api/print-provider/*`) - External API dependencies
10. **Job routes** (`/api/jobs/*`) - Most complex, story generation

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
