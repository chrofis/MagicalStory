# Page and Image Architecture

This document explains how page counts, image counts, and credits flow through the MagicalStory system.

---

## Quick Reference: "If I select 10 pages, how many images will I get?"

| Book Type | Language Level | Print Pages | Scene Count | Images Generated | Layout |
|-----------|---------------|-------------|-------------|------------------|--------|
| **Bilderbuch** | 1st-grade | 10 | 10 | 10 | Combined (image + text per page) |
| **Kinderbuch** | standard | 10 | 5 | 5 | Separate (text page + image page) |
| **Jugendbuch** | advanced | 10 | 5 | 5 | Separate (text page + image page) |

---

## 1. User Selection (Frontend)

### File: `client/src/pages/wizard/WizardStep3BookSettings.tsx`

**Available Page Options:**
```javascript
const availablePageOptions = developerMode
  ? [4, 10, 14, 20, 24, 30, 34, 40, 44, 50]
  : [10, 14, 20, 24, 30, 34, 40, 44, 50];
```

**Language Levels (Book Types):**
| Level | German Name | Description | Words per Page | Layout |
|-------|-------------|-------------|----------------|--------|
| `1st-grade` | Bilderbuch | Early readers | 20-35 words | Image + text on same page |
| `standard` | Kinderbuch | Elementary school | 120-150 words | Text page facing image page |
| `advanced` | Jugendbuch | Advanced readers | 250-300 words | Text page facing image page |

**Credit Cost Display (line 78):**
```javascript
const creditsCost = pageCount * 10;  // Always 10 credits per print page
```

---

## 2. Credit Configuration (Server)

### File: `server.js` (lines 30-59)

```javascript
const CREDIT_CONFIG = {
  COSTS: {
    IMAGE_REGENERATION: 5,    // Cost to regenerate a single scene image
    COVER_REGENERATION: 5,    // Cost to regenerate a cover image
    PER_PAGE: 10,             // Credits per story page (e.g., 20-page story = 200 credits)
  },
  PRICING: {
    CENTS_PER_CREDIT: 5,      // 5 cents per credit (CHF 0.05)
    // So CHF 5 = 500 cents = 100 credits
  },
  LIMITS: {
    MIN_PURCHASE: 100,        // Minimum credits to purchase
    MAX_PURCHASE: 10000,      // Maximum credits to purchase
    INITIAL_USER: 500,        // Credits for new users
    INITIAL_ADMIN: -1,        // Unlimited credits for admins (-1)
  },
  STORY_PAGES: {
    MIN: 10,
    MAX: 100,
    DEFAULT: 20,
  },
};
```

**Credit Calculation:**
- Story creation: `pages * CREDIT_CONFIG.COSTS.PER_PAGE` = `pages * 10`
- Image regeneration: 5 credits per image
- Cover regeneration: 5 credits per cover

---

## 3. Scene Count Calculation (Critical Logic)

### Correct Implementation: `server.js` (lines 7480-7486)

```javascript
// Calculate number of story scenes to generate:
// - Picture Book (1st-grade): 1 scene per page (image + text on same page)
// - Standard/Advanced: 1 scene per 2 print pages (text page + facing image page)
const printPages = inputData.pages;  // Total pages when printed
const isPictureBookLayout = inputData.languageLevel === '1st-grade';
const sceneCount = isPictureBookLayout ? printPages : Math.floor(printPages / 2);
```

### Formula:
```
For Bilderbuch (1st-grade):
  sceneCount = printPages

For Kinderbuch/Jugendbuch (standard/advanced):
  sceneCount = floor(printPages / 2)
```

### Example Calculations:

| User Selection | Print Pages | Language Level | Scene Count | Images | Cover Images |
|---------------|-------------|----------------|-------------|--------|--------------|
| 10 pages Bilderbuch | 10 | 1st-grade | 10 | 10 | 3 (front, back, initial) |
| 10 pages Kinderbuch | 10 | standard | 5 | 5 | 3 |
| 20 pages Kinderbuch | 20 | standard | 10 | 10 | 3 |
| 30 pages Jugendbuch | 30 | advanced | 15 | 15 | 3 |

---

## 4. Generation Modes

### File: `server.js`

Three generation modes exist:

| Mode | Function | Default? | Description |
|------|----------|----------|-------------|
| `unified` | `processUnifiedStoryJob()` | **Yes** | Single prompt generates complete story with Art Director scene expansion |
| `pictureBook` | `processStorybookJob()` | No | Combined text+scene generation |
| `outlineAndText` | Legacy pipeline | No | Separate outline + text prompts |

### Routing (line 7512-7523):
```javascript
if (generationMode === 'unified') {
  return await processUnifiedStoryJob(jobId, inputData, ...);
}
if (generationMode === 'pictureBook') {
  return await processStorybookJob(jobId, inputData, ...);
}
// outlineAndText mode (legacy)
```

---

## 5. BUG FOUND: Unified Mode Scene Count

### Location: `server.js` line 6292

**Current (WRONG):**
```javascript
const sceneCount = inputData.pages;  // Always uses full page count!
```

**Should Be:**
```javascript
const isPictureBookLayout = inputData.languageLevel === '1st-grade';
const sceneCount = isPictureBookLayout ? inputData.pages : Math.floor(inputData.pages / 2);
```

### Impact:
When a user selects **Kinderbuch (standard) with 10 pages**:
- **Expected**: 5 scenes (5 text pages + 5 image pages = 10 print pages)
- **Actual**: 10 scenes (10 text pages + 10 images)

The same bug exists in `processStorybookJob` at line 4827, but that function is specifically for picture book mode so it's less critical.

---

## 6. Display Logic (Frontend)

### File: `client/src/components/generation/StoryDisplay.tsx` (lines 438-443)

```javascript
// Detect layout from actual data:
// - 1:1 layout (unified/storybook): 1 image per text page
// - 2:1 layout (outlineAndText): 1 image per 2 text pages
const isPictureBook = sceneImages.length === 0 ||
  storyPages.length === 0 ||
  sceneImages.length === storyPages.length; // Exact 1:1 match
```

The frontend auto-detects layout based on the ratio of images to text pages:
- If `sceneImages.length === storyPages.length` → Picture book (1:1)
- Otherwise → Standard book (2:1)

---

## 7. PDF Generation for Print

### File: `server/lib/pdf.js`

**Page Dimensions:**
```javascript
const PAGE_SIZE = mmToPoints(200);      // 20x20cm interior pages
const COVER_WIDTH = mmToPoints(416);    // Back + Front cover spread
const COVER_HEIGHT = mmToPoints(206);   // Cover height with bleed
```

**Layout Detection (line 87-97):**
```javascript
const isPictureBook = storyData.languageLevel === '1st-grade';

if (isPictureBook) {
  // Combined: image (85%) + text (15%) on same page
  addPictureBookPages(doc, storyData, storyPages);
} else {
  // Separate: text page then image page
  addStandardPages(doc, storyData, storyPages);
}
```

**Page Count for Printing:**
```javascript
// Picture book: 1 page per scene
// Standard: 2 pages per scene (text + image)
let actualPdfPages = isPictureBook ? storyPages.length : storyPages.length * 2;

// Must be even for print binding
const targetPageCount = actualPdfPages % 2 === 0 ? actualPdfPages : actualPdfPages + 1;
```

---

## 8. Gelato Print Products

### File: `server/lib/gelato.js`

The PDF page count is sent to Gelato for printing:
```javascript
const printPageCount = targetPageCount;  // From PDF generation
```

Products are matched based on:
- Cover type (softcover/hardcover)
- Page count range (min_pages, max_pages)
- Available page counts (specific valid counts)

---

## 9. Credit Flow Timeline

```
1. User selects pages (e.g., 10 pages Kinderbuch)
   └─ Credits needed: 10 * 10 = 100 credits

2. Job creation (POST /api/jobs/create-story)
   └─ Credits RESERVED from user balance atomically
   └─ Stored in story_jobs.credits_reserved

3. Story generation
   └─ If FAILS: Full refund of credits_reserved
   └─ If SUCCESS: credits_reserved zeroed, credit_transaction logged

4. Image regeneration (optional)
   └─ Each regeneration: 5 credits deducted immediately

5. Cover regeneration (optional)
   └─ Each cover: 5 credits deducted immediately
```

---

## 10. Key Functions Reference

| Function | Location | Input | Output |
|----------|----------|-------|--------|
| `getPageLabel()` | WizardStep3BookSettings.tsx:76 | pageCount, isTest | Display string with credits |
| `buildUnifiedStoryPrompt()` | storyHelpers.js:1922 | inputData, sceneCount | Prompt string |
| `calculateStoryPageCount()` | storyHelpers.js:310 | storyData, includeCoverPages | Total page count |
| `getReadingLevel()` | storyHelpers.js:280 | languageLevel | Description + words per page |
| `generatePrintPdf()` | pdf.js:40 | storyData | {pdfBuffer, pageCount} |
| `parseStoryPages()` | pdf.js:26 | storyData | Array of page texts |

---

## 11. Recommended Fixes

### Fix 1: Unified Mode Scene Count (HIGH PRIORITY)

**File:** `server.js` around line 6292

```javascript
// BEFORE:
const sceneCount = inputData.pages;

// AFTER:
const isPictureBookLayout = inputData.languageLevel === '1st-grade';
const sceneCount = isPictureBookLayout ? inputData.pages : Math.floor(inputData.pages / 2);
```

### Fix 2: Storybook Mode Scene Count (LOW PRIORITY)

**File:** `server.js` around line 4827

Same fix as above - currently only used for explicit pictureBook mode.

---

## 12. Testing Checklist

After fixing the bug:

- [ ] Generate 10-page Bilderbuch → Should have 10 scenes, 10 images
- [ ] Generate 10-page Kinderbuch → Should have 5 scenes, 5 images
- [ ] Generate 20-page Kinderbuch → Should have 10 scenes, 10 images
- [ ] Check PDF page counts match expected
- [ ] Verify credit deduction matches page count (not scene count)
