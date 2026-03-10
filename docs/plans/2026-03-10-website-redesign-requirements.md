# Website Redesign Requirements Spec

**Date:** 2026-03-10
**Goal:** Redesign magicalstory.ch to be consistent, trustworthy, and competitive with market leaders — while keeping a down-to-earth, genuine tone.

---

## Part 1: Competitor Landscape Summary

### Market Overview (9 competitors analyzed)

| Competitor | Type | Pricing | Social Proof | Tone |
|-----------|------|---------|-------------|------|
| **Wonderbly** | Template | ~$30+ | 10M readers, Trustpilot | Warm, emotional |
| **Hooray Heroes** | Template | $37-47 | 3M books sold | "No AI, No Shortcuts" |
| **Librio** | Template | $34.99 | 4.95/5, 6,724 reviews, 950K customers | Warm, hand-drawn |
| **Namee** | Template | $34.99 | 2,823 reviews, media mentions | Inclusive, thoughtful |
| **Imagitime** | AI+Photo | Hidden | 150K customers, 1K+ 5-star reviews | Warm, privacy-first |
| **Magic Story** | AI+Photo (App) | $30-40 | 4.8/5, 3K+ parents | "Pixar-quality" |
| **Make My Book** | AI+Photo | €1/2 pages | Trustpilot 4.6, 10K+ families | Down-to-earth |
| **Childbook.ai** | AI | $2.50/book | None | Feature-focused |
| **DreamStories.ai** | AI+Photo | Unknown | 4.8/5, 1,436 reviews | Very down-to-earth |

### Key Industry Patterns

1. **Nobody leads with "AI"** — established players don't mention it. AI-native competitors focus on outcomes ("your child as the hero"), not technology.
2. **"Keepsake" is the universal positioning word** — signals permanence vs disposable entertainment.
3. **3-4 step "How it works" is standard** — always: Upload/Choose → Customize → Preview/Create → Print/Gift.
4. **Social proof is critical** — every successful site shows rating + review count + customer count prominently.
5. **Privacy messaging is a must** — parents uploading children's photos need explicit reassurance.
6. **Time estimates reduce anxiety** — "2 minutes to create," "shipped in 3 days."
7. **Free preview/trial lowers friction** — Imagitime's "Create Free Preview" is best-in-class CTA.
8. **Down-to-earth tone wins** — nobody does over-the-top hype. Warm, genuine, parent-focused.

### Best-in-Class Examples to Learn From

- **Librio:** Social proof presentation (4.95/5, 6,724 reviews — visible everywhere)
- **Imagitime:** "Create Free Preview" CTA, privacy-first messaging, hidden pricing until after preview
- **Make My Book:** Time estimates in "How it works" (1 min → 5 min → 10 min), therapeutic positioning
- **Wonderbly:** Emotional, non-technical copy ("Bottle the baby stage forever")
- **Namee:** Understated warmth ("Thoughtful Presents for Your Favorite People")

---

## Part 2: Current Site Audit (magicalstory.ch)

### What's Working
- Trial flow CTA goes to `/try` — good low-friction entry
- Hero video demonstration (photo → avatar → book) is effective
- Trilingual support (EN/DE/FR) is a real advantage
- Step-by-step feature explanation is clear
- Indigo brand color is consistent for primary actions

### What's Not Working

#### Messaging Issues
| Current | Problem | Recommendation |
|---------|---------|----------------|
| "Become the hero of your story" | Generic, every competitor says this | More specific, emotional headline |
| "Turn your wildest ideas into a breathtaking personalized tale" | Over-the-top ("wildest," "breathtaking") | Down-to-earth: focus on the real outcome |
| "make someone feel like the legend they truly are" | Too hyperbolic | Simpler: "a gift they'll treasure" |
| "Ready to Create Magic?" | Cliché | More genuine CTA section |
| "Our AI analyzes each photo to capture unique features" | Leads with technology, not benefit | Lead with benefit: "Watch them come to life" |
| No social proof anywhere | Massive trust gap | Add numbers as soon as available |
| No privacy messaging | Major concern for parents | Add "Photos are never shared or stored" |
| No pricing visibility | Creates uncertainty | At minimum show "Free to try, printed books from CHF X" |
| "Ships within Switzerland" | Limiting (even if true) | Broader delivery messaging or remove limitation |

#### Structural Issues
| Issue | Details |
|-------|---------|
| No testimonials section | Every competitor has at least fake-it-till-you-make-it social proof |
| No pricing section on landing | Users have to dig to find what it costs |
| No FAQ section | Common questions go unanswered (How long? What age? What quality?) |
| No example gallery | Users can't see finished books before committing |
| Black nav bar | Disconnected from indigo brand |
| No "How long does it take?" | Competitors show "2 minutes" or "ready in seconds" |

---

## Part 3: Internal Design Consistency Audit

### Overall Score: 6.5/10

#### Good (Keep)
- Alert/Badge/Toast system is excellent (consistent semantic colors)
- Input/Textarea components are well-standardized
- Modal component is consistent
- Responsive breakpoints are thoughtfully applied
- Color system (indigo primary) works

#### Inconsistent (Fix)

| Element | Problem | Examples |
|---------|---------|---------|
| **Buttons** | Marketing pages use custom inline styles instead of Button component | Landing hero: `rounded-xl hover:scale-105` vs Button: `rounded-lg hover:scale-[1.02]` |
| **Card corners** | Mixed `rounded-xl` and `rounded-2xl` | MyStories cards: `rounded-xl`, Card component: `rounded-2xl` |
| **Typography** | Heading font (Cinzel) not used consistently | WizardStep2, MyStories, Pricing use sans instead of serif |
| **Shadows** | Ranges from `shadow-md` to `shadow-2xl` without pattern | GeneratingStoryCard: `shadow-md`, Card: `shadow-lg`, Landing buttons: `shadow-xl` |
| **Page padding** | Different values per page | Landing: `px-4 lg:px-8`, MyStories: `px-4 md:px-8`, Wizard: `px-3` |
| **Max-width** | Different per page | Landing: `max-w-6xl`, MyStories: `max-w-7xl`, Pricing: `max-w-4xl` |
| **Nav bar** | Pure black background | Should use brand color (dark indigo) or dark gray |

---

## Part 4: Redesign Requirements

### R1: Messaging & Tone

**Principle:** Down-to-earth, warm, genuine. No hyperbole. Focus on emotional outcomes, not technology.

#### R1.1: Hero Section Rewrite
- **Headline options (pick one, test):**
  - DE: "Ein Buch, in dem dein Kind die Hauptrolle spielt"
  - EN: "A book where your child is the main character"
  - Alt: "Personalized picture books your child will treasure"
- **Subheadline:** One sentence about the real benefit. E.g. "Upload a photo, choose an adventure, and receive a beautifully illustrated book featuring your child."
- **Remove:** "wildest ideas," "breathtaking," "legend," any superlatives
- **CTA:** "Create a Free Preview" (not "Create a Free Story" — "preview" is lower commitment, following Imagitime's best practice)

#### R1.2: Feature Sections Rewrite
- Lead with benefits, not technology
- Remove "Our AI analyzes each photo" — replace with "Watch them come to life in the story"
- Add time estimate: "Ready in about 10 minutes"
- Keep 4-step structure (it's industry standard)
- Each step should have: clear heading + 1-sentence description + 2-3 bullet benefits

#### R1.3: Claims Level
- **Allowed:** "personalized," "unique," "beautiful," "illustrated," "keepsake," "treasure"
- **Not allowed:** "magical" (in body copy — OK in brand name), "breathtaking," "wildest," "legend," "incredible," "revolutionary," "amazing"
- **Tone test:** Would a Swiss parent say this to a friend? If not, tone it down.

### R2: Trust & Social Proof

#### R2.1: Social Proof Section (new)
- Add between features and final CTA
- Show: number of stories created + star rating (collect from early users)
- Even before real reviews: "Join X families who've created their personalized book"
- Add 3-5 short testimonials (collect real ones from test users/family)

#### R2.2: Privacy Statement
- Add visible on landing page: "Your photos are private. We never share, sell, or use them for anything else."
- Consider a small shield/lock icon next to photo upload areas
- Link to privacy policy

#### R2.3: Quality Guarantee
- "Not happy? We'll make it right." or similar low-key guarantee
- No need for money-back (it's free to create) — focus on satisfaction with printed product

### R3: Missing Sections

#### R3.1: Example Gallery
- Show 3-4 finished book spreads (different styles: Pixar, Watercolor, Comic)
- Use real generated examples (anonymized or with permission)
- Horizontal scroll on mobile, grid on desktop

#### R3.2: Pricing Preview
- Add a simple section: "Free to create and preview. Printed books from CHF 29.90"
- Don't need full pricing table on landing page — just set expectations
- Link to full pricing page

#### R3.3: FAQ Section
- 5-7 questions: How long does it take? What ages? Can I add multiple characters? What art styles? How is it printed? Delivery time? Is my data safe?
- Accordion/collapsible format
- Place before final CTA

#### R3.4: "How Long Does It Take?" Indicator
- In the hero or "How it Works" section
- "From photo to finished book preview in about 10 minutes"
- Competitors show this prominently — it reduces anxiety

### R4: Design System Consistency

#### R4.1: Button Standardization
- ALL buttons must use the Button component — no inline Tailwind overrides
- Remove custom hover scales, rounded values, and shadows from marketing pages
- If the Button component needs a larger variant for hero CTAs, add a `size="xl"` variant

#### R4.2: Card Standardization
- All cards use `rounded-2xl` (matching Card component)
- Shadow scale: Cards = `shadow-lg`, Hover = `shadow-xl`, Modals = `shadow-2xl`
- MyStories, GeneratingStoryCard must match Card component

#### R4.3: Typography Hierarchy
- H1 (page title): Cinzel, `text-3xl md:text-5xl`
- H2 (section title): Cinzel, `text-2xl md:text-4xl`
- H3 (card/subsection title): Sans (Inter), `text-xl font-bold`
- Body: Sans, `text-base md:text-lg`, `text-gray-600`
- Enforce: every page heading uses Cinzel, not sans

#### R4.4: Navigation Bar
- Change from `bg-black` to `bg-gray-900` or `bg-indigo-950`
- Keeps dark contrast but connects to brand palette

#### R4.5: Spacing & Layout
- All content sections: `max-w-6xl mx-auto`
- Page padding: `px-4 md:px-6 lg:px-8` (standardize)
- Section vertical spacing: `py-16 lg:py-24` (standardize)

### R5: Mobile Experience

#### R5.1: Text Sizing
- Body text minimum `text-base` on mobile (not `text-sm`)
- CTAs large enough for thumb taps: minimum `py-3 px-6`

#### R5.2: Touch Targets
- All interactive elements minimum 44x44px (Apple HIG)
- Adequate spacing between tappable elements

#### R5.3: Performance
- Lazy-load below-fold images
- Hero video should have poster frame (don't autoplay on slow connections)
- Keep landing page under 3 seconds first contentful paint

### R6: Page-Specific Requirements

#### R6.1: Landing Page (Priority: HIGH)
- Implement all R1-R5 changes
- New section order: Hero → How it Works (4 steps) → Example Gallery → Social Proof/Testimonials → Pricing Preview → FAQ → Final CTA → Footer

#### R6.2: Trial Flow (Priority: MEDIUM)
- Ensure consistent with landing page design language
- Progress indicators should match brand colors
- Error states should use Alert component (not custom styling)

#### R6.3: My Stories (Priority: MEDIUM)
- Standardize card styling (rounded-2xl, shadow-lg)
- Consistent spacing with other pages

#### R6.4: Story Wizard (Priority: LOW — internal tool)
- Typography consistency (use Cinzel for step titles)
- Standardize section padding

#### R6.5: Login/Register (Priority: MEDIUM)
- Professional, clean, matches landing page
- Social proof reminder ("Join X families")

---

## Part 5: Implementation Priority

### Phase 1: Quick Wins (1-2 days)
1. Rewrite hero headline and subheadline (remove hyperbole)
2. Change CTA text to "Create a Free Preview"
3. Add privacy statement to landing page
4. Change nav bar from black to dark indigo
5. Standardize all buttons to use Button component
6. Add "About 10 minutes" time indicator

### Phase 2: New Sections (3-5 days)
1. Add example gallery section with real book spreads
2. Add FAQ section (accordion)
3. Add pricing preview section
4. Add placeholder social proof section (update with real numbers later)
5. Standardize card styling across all pages

### Phase 3: Typography & Polish (2-3 days)
1. Enforce Cinzel for all page/section headings
2. Standardize spacing scale across all pages
3. Standardize max-widths
4. Review and fix mobile text sizes
5. Add lazy loading for below-fold images

### Phase 4: Social Proof (Ongoing)
1. Collect real testimonials from early users
2. Implement review/rating collection post-purchase
3. Add story creation counter (automated)
4. Consider Trustpilot integration

---

## Part 6: Copy Guidelines

### Words to Use
- personalized, illustrated, unique, keepsake, treasure, adventure, gift, family, character, story, book, printed, quality

### Words to Avoid
- magical (in body copy), breathtaking, wildest, legend, incredible, revolutionary, amazing, stunning, mind-blowing

### Sentence Style
- Short sentences. Active voice. Second person ("your child," "you").
- Max 20 words per sentence in marketing copy.
- One idea per paragraph.
- Test: "Would a parent say this to a friend at a playground?" If no, rewrite.

### Example Rewrites

| Before | After |
|--------|-------|
| "Turn your wildest ideas into a breathtaking personalized tale" | "Choose an adventure and see your child illustrated on every page" |
| "Make someone feel like the legend they truly are" | "A personalized gift they'll want to read again and again" |
| "Our AI analyzes each photo to capture unique features, expressions, and personality" | "Upload a photo and watch your child come to life as an illustrated character" |
| "Ready to Create Magic?" | "Ready to create your book?" |
| "Create a Free Story" | "Create a Free Preview" |
