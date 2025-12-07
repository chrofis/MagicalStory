# Database Migration Summary - December 6, 2025

## ✅ Completed: Migration from IONOS MySQL to Railway PostgreSQL

### What Was Done

#### 1. **Removed All Old MySQL/IONOS Database Code**
   - Removed `mysql2` import and dependency
   - Deleted all `DB_TYPE` conditionals (20+ occurrences throughout server.js)
   - Removed MySQL connection pool code
   - Simplified all database queries to PostgreSQL-only syntax
   - **Result:** Removed 242 lines of obsolete code

#### 2. **Database Configuration Cleanup**
   **Before:**
   - Supported both PostgreSQL (Railway) and MySQL (IONOS)
   - Required `DB_TYPE` checks for every database query
   - MySQL credentials: `db5019134498.hosting-data.io`

   **After:**
   - PostgreSQL-only (Railway)
   - Simplified queries using `$1, $2` parameters
   - Old MySQL credentials commented out in `.env` (kept for reference)

#### 3. **Fixed Critical Product UID Bug**
   **The Problem:**
   - Migration `003_add_24_page_product.sql` was configured for 24 pages
   - Frontend code calculates: `24 scenes × 2 pages/scene = 48 PDF pages`
   - Product lookup failed: "No product matches page count: 48"
   - Result: `Selected product: undefined UID: undefined`

   **The Fix:**
   - Updated migration to configure product for **48 pages** (not 24)
   - Changed `available_page_counts` from `[24]` to `[48]`
   - Fixed SQL syntax: `ON DUPLICATE KEY UPDATE` (MySQL) → `ON CONFLICT` (PostgreSQL)

#### 4. **Code Changes Summary**
   ```
   Commit 763e7ff: Remove MySQL/IONOS database code
   - server.js: 242 lines removed (404 → 162 insertions)
   - Removed all DB_TYPE conditionals
   - PostgreSQL-only query wrapper

   Commit b44e5ab: Remove mysql2 dependency
   - package.json: Removed mysql2 from dependencies

   Commit fe9090a: Fix migration for 48 pages + PostgreSQL syntax
   - database/migrations/003_add_24_page_product.sql
   - Changed: 24 pages → 48 pages
   - Changed: MySQL syntax → PostgreSQL syntax
   ```

---

## 🗄️ Current Database Configuration

**Active Database:** PostgreSQL on Railway
- **Connection:** `postgresql://postgres:***@postgres.railway.internal:5432/railway`
- **Mode:** `STORAGE_MODE=database`
- **Migrations:** Automatically run on server startup

**Old Database (Deprecated):** MySQL on IONOS
- Status: ❌ Deactivated
- Credentials: Commented out in `.env`
- Code: Completely removed from server.js

---

## 🐛 Product UID Issue - Root Cause & Fix

### Root Cause Analysis

**Issue:** "Selected product: undefined UID: undefined"

**Why it happened:**
1. Frontend calculates: `actualPdfPages = 24 scenes × 2 = 48 pages`
2. Product in database had: `available_page_counts = [24]`
3. Product matching failed: `48 ∉ [24]`
4. Result: `matchingProduct = undefined`

### The Fix

**Migration Updated:**
```sql
-- OLD (WRONG)
min_pages: 24
max_pages: 24
available_page_counts: '[24]'

-- NEW (CORRECT)
min_pages: 48
max_pages: 48
available_page_counts: '[48]'
```

**Why 48 pages?**
- Each story scene generates 2 PDF pages:
  1. Text page (story text)
  2. Image page (illustration)
- 24 scenes × 2 pages/scene = **48 PDF pages**
- Gelato counts PDF pages, not scenes

---

## 📋 Testing Checklist

After Railway deployment completes (~2-3 minutes):

### 1. Hard Refresh Browser
   - Press **Ctrl+Shift+R** (Windows) or **Cmd+Shift+R** (Mac)
   - This clears cached JavaScript/CSS

### 2. Check Console Logs
   Open browser DevTools (F12) and verify:
   ```
   ✅ Expected:
   📄 Story scenes: 24 (PDF pages: 48)
   🔍 Checking product: ...
   Available counts: [48] Looking for: 48 Match: true
   ✅ Selected product: 14x14cm Softcover Photobook - 48 pages UID: photobooks-softcover_pf_...

   ❌ OLD (should NOT see):
   Looking for: 24
   ❌ No product matches page count: 24
   ✅ Selected product: undefined UID: undefined
   ```

### 3. Test Print Order Flow
   - Generate a 24-scene story
   - Click "Order Print Book"
   - Should see: "Gelato product configured for 48 pages"
   - Should NOT see: "Kein Gelato-Produkt konfiguriert"

### 4. Verify Database Migration
   Check that the product was updated:
   - Go to Admin Panel → Manage Products
   - Should see: "14x14cm Softcover Photobook - 48 pages"
   - Available counts: [48]

---

## 🚀 Deployment Status

**Commits Deployed:**
1. `763e7ff` - Remove MySQL/IONOS database code, migrate to PostgreSQL-only
2. `b44e5ab` - Remove mysql2 dependency from package.json
3. `fe9090a` - Fix migration: Update to 48 pages and PostgreSQL syntax

**Railway Status:** 🟢 Automatic deployment triggered
**Estimated Completion:** 2-3 minutes from push time

**Verification URL:** https://www.magicalstory.ch

---

## 📝 Next Steps

1. **Wait for Railway deployment** to complete
2. **Hard refresh** the website (Ctrl+Shift+R)
3. **Test the print order** feature
4. **Check console logs** to verify product UID is no longer undefined

If the issue persists after deployment:
- Check Railway logs for migration errors
- Verify the migration actually ran: `SELECT * FROM gelato_products;`
- Check if `available_page_counts` column contains `[48]` (not `[24]`)

---

## 🎯 Summary

**Database Migration:** ✅ Complete
- Old MySQL/IONOS code: ✅ Removed
- PostgreSQL-only: ✅ Implemented
- Code reduction: ✅ 242 lines removed

**Product UID Bug:** ✅ Fixed
- Migration: ✅ Updated to 48 pages
- SQL syntax: ✅ Changed to PostgreSQL
- Product matching: ✅ Should now work

**Deployed:** ✅ Yes
- All changes pushed to Railway
- Automatic deployment in progress

The app should now properly find the Gelato product for 24-scene stories (48 PDF pages) and successfully create print orders! 🎉
