# MagicalStory TODO

## Bugs / High Priority

- [ ] Legal - add email legal@magicalstory.ch & privacy@magicalstory.ch
- [ ] Legal - block US
- [ ] Legal - delete images after 30 days
- [ ] Avatar creation flow: First generate without physical details, then read from avatar, then use for future avatars

---

## Features / Ideas

### User Experience
- [ ] Pop up to guide first time users through webpage
- [ ] Propose stories based on main character
- [ ] Allow to configure a 2nd story while first one is generating
- [ ] Avatar generation only upon Email verification
- [ ] Home page convert pictures to animated gifs

### Image Generation
- [ ] Image evaluation for cover images (quality scoring)
- [ ] Scene prompt restructure: Instructions first, characters & bible 2nd, story 3rd

---

## Technical Debt & Refactoring

### Completed (2024-12)

#### Security & Validation
- [x] Rate limiting for `/log-error` endpoint
- [x] File upload validation (size, MIME type)
- [x] Password validation consistency (min 8 chars)
- [x] Image regeneration rate limiting

#### Frontend
- [x] Extract wizard step components (WizardStep1-4)
- [x] Extract StoryDisplay modals (SceneEditModal, ImageHistoryModal, EnlargedImageModal)
- [x] Replace all alert() calls with Toast notifications
- [x] Extract CreditsModal from Navigation.tsx
- [x] Create useDeveloperMode hook

### Pending - Server Route Extraction

#### Extract Webhook Handlers (~450 lines)
**From:** `server.js` → **To:** `server/routes/webhooks.js`
- `POST /api/stripe/webhook`
- `POST /api/gelato/webhook`

#### Extract PDF Generation (~700 lines)
**From:** `server.js` → **To:** `server/routes/pdf.js`
- `GET /api/stories/:id/pdf`
- `GET /api/stories/:id/print-pdf`
- `POST /api/generate-pdf`
- `POST /api/generate-book-pdf`

#### Extract Payment Endpoints (~250 lines)
**From:** `server.js` → **To:** `server/routes/payments.js`
- `GET /api/pricing`
- `POST /api/stripe/create-checkout-session`
- `POST /api/stripe/create-credits-checkout`

#### Extract Job Management (~530 lines)
**From:** `server.js` → **To:** `server/routes/jobs.js`
- `POST /api/jobs/create-story`
- `GET /api/jobs/:jobId/status`
- `POST /api/jobs/:jobId/cancel`

### Pending - Frontend Refactoring (Optional)

#### StoryWizard.tsx (2555 lines)
- [ ] Extract `useWizardNavigation.ts` hook
- [ ] Extract `WizardStep5Generation.tsx`

#### StoryDisplay.tsx (2341 lines)
- [ ] Extract `TitleEditor.tsx`
- [ ] Extract `PageDisplay.tsx`

#### CharacterForm.tsx (750 lines)
- [ ] Extract step components

### Pending - Performance
- [ ] Admin users pagination
- [ ] Gelato batch queries
- [ ] Move MODEL_PRICING to config file

### Duplicate Endpoints (Fix Required)

**1. `PATCH /api/stories/:id/page/:pageNum`** - Defined in TWO places:
| Location | Line | Status |
|----------|------|--------|
| `server.js` | 3294 | Active (hit first) |
| `server/routes/stories.js` | 741 | Active (never reached) |

**Action:** Remove from `server.js`, keep only in `stories.js`

**2. Print Products Admin** - Two different paths for same functionality:
| Path | Location | Status |
|------|----------|--------|
| `/api/admin/print-provider/products` | `server.js:3799` | Legacy |
| `/api/admin/print-products/` | `admin/print-products.js` | Current |

**Action:** Deprecate `/print-provider/` path, use `/print-products/` only

### Missing Route Exports

- [ ] `avatarsRoutes` loaded directly in server.js, not exported from `server/routes/index.js`

---

## Future Improvements

### Image Inpainting Alternatives

**Current Implementation:**
- Model: Gemini 2.5 Flash Image (~$0.04/image)
- Limitation: No true mask support - uses text-based coordinates
- Issue: Large area repairs (>25%) fail - we skip them

**Recommended: Stability AI SDXL**
| Aspect | Value |
|--------|-------|
| Cost | ~$0.01/image (4x cheaper) |
| Setup | Simple API key |
| Features | True binary mask support |

**Alternative APIs:**
| Provider | Model | Cost | Mask Support |
|----------|-------|------|--------------|
| Google Imagen 3 | Imagen 3 | $0.04 | Binary + dilation |
| Google Imagen 3 | Imagen 3 Fast | $0.02 | Binary + dilation |
| Stability AI | SDXL Inpaint | $0.01 | Full mask |
| Replicate | FLUX Fill Pro | $0.05 | Paint-based |
| OpenAI | GPT Image 1 Mini | $0.005-0.05 | Mask editing |

### Face Identity Preservation (Research Completed)

**PuLID-FLUX Testing Results (Jan 2025): NOT Recommended**

Problems found:
- Smooth/painterly skin - looks like digital paintings
- Identity drift - randomly adds/changes features
- Pose prompts ignored - always front-facing
- Unpredictable results
- ~$0.07/image for mediocre quality

**Conclusion:** Stick with Gemini for avatar generation. See `docs/FACE-EMBEDDINGS-RESEARCH.md` for full details.

---

## Completed (Archive)

<details>
<summary>Previously completed items</summary>

- [x] Cover image at start of prompt
- [x] Show user "my orders"
- [x] Order handling Emails
- [x] Email language
- [x] Height in scene generation (cm → relative height)
- [x] Cover images keep clothing style
- [x] "Deine Geschichte" as title
- [x] PDF line spacing
- [x] ä in Text
- [x] Image format consistency
- [x] Token limit 9200
- [x] Plot truncation at 24 pages
- [x] Story book print
- [x] Pass only needed characters
- [x] Image prompt language (German)
- [x] Steampunk photo
- [x] Watercolor style
- [x] Sequential images
- [x] New story clearing
- [x] Relationships narrow box
- [x] Character consistency for non-main characters
- [x] Avatar placement (2 next to each other)
- [x] Next button slow on relationships
- [x] Bad example crowd
- [x] Store character performance
- [x] Thumbnail padding
- [x] Email to rogerfischer
- [x] Email direct link to story
- [x] Printing functionality
- [x] Text length definition
- [x] "Meine Geschichten" centering, back button
- [x] Admin dashboard
- [x] Print book
- [x] Page count
- [x] Multiple stories in one book
- [x] PDF text overflow, font scaling
- [x] Password login
- [x] Remove test for 10 images
- [x] Pages in story generation
- [x] Hardcover and Softcover
- [x] Buy credits
- [x] Generate story prompt
- [x] Art styles images
- [x] Art styles prompts
- [x] Generate story button
- [x] Home page pictures
- [x] Remove character relations
- [x] Privacy approval persistence
- [x] Accept click area
- [x] Person detection
- [x] Home page layout
- [x] Model display in developer view
- [x] Status check on back navigation
- [x] Back button navigation
- [x] Secondary characters in scene composition

</details>
