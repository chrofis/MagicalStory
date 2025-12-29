**Bugs / Features**

verify Email sends back to login screen not generating the story

No 2nd Email is sent

generate pdf button colour

Legal - add email legal@magicalstory.ch \& privacy@magicalstory.ch

Legal - block US

Home page snaps below the step 1

Home page, last button like first button





**Ideas:**

Allow user to edit how avatar should be, hair, build \& clothing

Single page for story generation

Allow to configure a 2nd story while first one is generating

Avatar generation only upon Email verification

Image evalution for cover images

Home page convert pictures to animated gifs

Szene prompt to be restructured. Instructions what to do first, characters \& bible 2nd, story 3rd





**Test:**

Allow users to edit text

Allow users to regenerate image

Show which model was used in developer view

When going back status is not checked

Back buttons don't point back

Scene prompt to use previous page and scene text as input, not just current page.

Email verification before generating story

ein emoji in home page unter button

streaming display

regenerate does not work

Regenerating cover

story generation does not work anymore

Allow to select characters

Character count completely wrong.

Token count seems off







---

# Technical Debt & Refactoring (2024-12-29)

## Completed

### Security & Validation
- [x] Rate limiting for `/log-error` endpoint
- [x] File upload validation (size, MIME type)
- [x] Password validation consistency (min 8 chars)
- [x] Image regeneration rate limiting

### Frontend
- [x] Extract wizard step components (WizardStep1-4)
- [x] Extract StoryDisplay modals (SceneEditModal, ImageHistoryModal, EnlargedImageModal)
- [x] Replace all alert() calls with Toast notifications
- [x] Extract CreditsModal from Navigation.tsx
- [x] Create useDeveloperMode hook

---

## Pending - Server Route Extraction

### Extract Webhook Handlers (~450 lines)
**From:** `server.js` → **To:** `server/routes/webhooks.js`
- `POST /api/stripe/webhook`
- `POST /api/gelato/webhook`

### Extract PDF Generation (~700 lines)
**From:** `server.js` → **To:** `server/routes/pdf.js`
- `GET /api/stories/:id/pdf`
- `GET /api/stories/:id/print-pdf`
- `POST /api/generate-pdf`
- `POST /api/generate-book-pdf`

### Extract Payment Endpoints (~250 lines)
**From:** `server.js` → **To:** `server/routes/payments.js`
- `GET /api/pricing`
- `POST /api/stripe/create-checkout-session`
- `POST /api/stripe/create-credits-checkout`

### Extract Job Management (~530 lines)
**From:** `server.js` → **To:** `server/routes/jobs.js`
- `POST /api/jobs/create-story`
- `GET /api/jobs/:jobId/status`
- `POST /api/jobs/:jobId/cancel`

---

## Pending - Frontend Refactoring

### StoryWizard.tsx (2555 lines → target <1500)
- [ ] Extract `useWizardNavigation.ts` hook
- [ ] Extract `useStoryConfiguration.ts` hook
- [ ] Extract `useCharacterManagement.ts` hook
- [ ] Extract `WizardStep5Generation.tsx` component

### StoryDisplay.tsx (2341 lines → target <1500)
- [ ] Extract `TitleEditor.tsx`
- [ ] Extract `PageDisplay.tsx`
- [ ] Extract `CoverSection.tsx`

### CharacterForm.tsx (750 lines → target <400)
- [ ] Extract `CharacterNameStep.tsx`
- [ ] Extract `CharacterTraitsStep.tsx`
- [ ] Extract `AvatarSection.tsx`

---

## Pending - Performance

- [ ] Admin users pagination
- [ ] Gelato batch queries
- [ ] Move MODEL_PRICING to config file

---

**done**

Cover image at start of prompt, so this can start to generate early

Show user "my orders"

Order handling Emails

Email language

height has to be changed in scene generation prompt from cm, to relative height (much bigger than)

Cover images to keep clothing style

Deine Geschichte sollte der Titel sein

Keine Linien Abstände im PDF print out

keine ä im Text

Bilder mit unterschiedlichen Format

Wieso limite von 9200 tokens

plot bei 24 Seiten abgeschnitten

story book print

Dont't pass all characters only the ones needed

Bild prompt nicht Deutsch

steampunk photo ändern

watercolor style hinzufügen

sequential Bilder

new story löscht alles

Narrow box in relationships

character consistent, if not main character, example siam katzen

place avatar, 2 next to each other not 4

next slow on relationships

bad example crowd hinzufügen

Store character takes too long

A bit more padding on thumbnail

Email to rogerfischer

Email does not link directly to story

printing does not work

Text länge wo definiert?

Meine Geschichten zentriert, back Pfeil eindeutiger

admin dashboard

print book

Page count is off

Mehrere Geschichten in einem Buch

Text zu lange für pdf, font verkleinerung funktioniert?

Entering password does not log on

Remove the test for 10 images

Pages do not appear in story generation

Hardcover und Softcover

Buy credits to create more stories

generate story prompt

art styles missing images

art styles, missing prompts

generate story button change colour and location

home page add pictures

removing character does not remove relations

Even if user has approved privacy it is asked again

Click for the accept is below the box

No person detected



