# SEO & Theme Pages Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make every public page SEO-optimized with per-page meta tags, structured data, proper sitemap/robots, and create theme landing pages that turn 15 indexable pages into 200+ pages targeting specific parent search queries.

**Architecture:** Server-side meta tag injection in Express SPA handler (no SSR/Next.js migration). Theme pages as a single React component rendering from existing `storyTypes.ts` data. Phase 3 (multilingual URLs) deferred — see rationale below.

**Tech Stack:** Express.js (server-side injection), React + React Router, JSON-LD structured data

---

## Phase 3 Decision: Multilingual URLs Deferred

**Rationale:** Full language-prefix routing (`/en/`, `/fr/`, `/de/`) requires:
- Modifying every `<Link>` component across the entire app
- Changing React Router structure to nest under `/:lang/`
- Server-side language detection and redirect logic
- Duplicating sitemap entries x3

This is a 2-week project that risks breaking existing functionality. The simpler, high-impact alternative:
- Server-side `hreflang` tags pointing to `?lang=en`, `?lang=de`, `?lang=fr` variants
- Google recognizes query-param language variants when hreflang is correct
- Can upgrade to path prefixes later without losing anything

**Decision:** Implement hreflang with query params now. Path prefixes are a future phase.

---

## Theme Inventory

From `client/src/constants/storyTypes.ts`:

| Category | Source Array | Count | Example IDs |
|----------|-------------|-------|-------------|
| Adventure | `storyTypes` | 36 | pirate, knight, wizard, dragon, space |
| Life Challenges | `lifeChallenges` | 50+ | potty-training, first-school, new-sibling |
| Educational | `educationalTopics` | 30+ | alphabet, planets, farm-animals |
| Historical | `historicalEvents` | 70+ | wilhelm-tell, moon-landing, pyramids |

**Total theme pages:** ~190 individual themes + 4 category index pages + 1 themes overview = **~195 pages**

---

## Task 1: Server-Side Meta Tag Injection

**Files:**
- Modify: `server.js` (SPA fallback handler, ~line 5012)
- Create: `server/lib/seoMeta.js` (route-to-meta mapping)

### Step 1: Create SEO meta mapping module

Create `server/lib/seoMeta.js` with a function `getMetaForRoute(path)` that returns:
```js
{
  title: 'Page Title - Magical Story',
  description: 'Meta description for this page...',
  canonical: '/path',
  ogTitle: 'OG Title',
  ogDescription: 'OG Description',
  jsonLd: null | object,  // page-specific structured data
  hreflang: [{ lang, href }],  // language alternates
  noindex: false  // for auth pages
}
```

**Static route mappings (hardcoded):**

| Route | Title (EN) | Title (DE) |
|-------|-----------|-----------|
| `/` | Magical Story – Personalized Children's Books | Magical Story – Personalisierte Kinderbücher |
| `/pricing` | Pricing – Magical Story | Preise – Magical Story |
| `/faq` | FAQ – Magical Story | FAQ – Magical Story |
| `/about` | About – Magical Story | Über uns – Magical Story |
| `/contact` | Contact – Magical Story | Kontakt – Magical Story |
| `/try` | Create Your Free Story – Magical Story | Gratis Geschichte erstellen – Magical Story |
| `/terms` | Terms of Service – Magical Story | Nutzungsbedingungen – Magical Story |
| `/privacy` | Privacy Policy – Magical Story | Datenschutz – Magical Story |
| `/impressum` | Impressum – Magical Story | Impressum – Magical Story |
| `/themes` | Story Themes – Magical Story | Story-Themen – Magical Story |

**Dynamic route mappings (`/themes/:category/:themeId`):**
- Import theme data from `storyTypes.ts` (or duplicate as plain JS in server)
- Generate title/description from theme name and category
- Example: `/themes/life-challenges/first-school` → "First Day of School – Personalized Story | Magical Story"

**Auth/private routes (noindex):**
- `/create/*`, `/stories`, `/orders`, `/admin`, `/book-builder`, `/welcome`, `/trial-generation`, `/claim/*`, `/reset-password/*`, `/email-verified`

### Step 2: Modify SPA fallback handler

Replace the current handler in `server.js` (~line 5012):

```js
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();

  if (hasDistFolder) {
    const html = fs.readFileSync(path.join(distPath, 'index.html'), 'utf8');
    const meta = getMetaForRoute(req.path, req.query.lang);
    const injected = injectMeta(html, meta);
    res.send(injected);
  } else {
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});
```

The `injectMeta()` function replaces placeholders in index.html:
- `<title>...</title>` → page-specific title
- `<meta name="description" content="...">` → page-specific description
- `<link rel="canonical" href="...">` → page canonical
- OG tags (og:title, og:description, og:url)
- Twitter tags
- `<meta name="robots" ...>` → noindex for auth pages
- JSON-LD script block → page-specific structured data
- Add hreflang `<link>` tags

**Performance note:** Cache the base HTML template in memory (read once at startup, not per request).

### Step 3: Add FAQPage JSON-LD

For `/faq`, inject FAQPage structured data from the FAQ content. This enables rich FAQ snippets in Google search results.

```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "How does it work?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Upload a photo..."
      }
    }
  ]
}
```

### Step 4: Commit

```
feat: add server-side SEO meta injection for all public pages
```

---

## Task 2: Fix sitemap.xml and robots.txt

**Files:**
- Modify: `client/public/sitemap.xml`
- Modify: `client/public/robots.txt`

### Step 1: Update robots.txt

```
User-agent: *
Allow: /

Disallow: /api/
Disallow: /admin/
Disallow: /create/
Disallow: /stories
Disallow: /orders
Disallow: /book-builder
Disallow: /welcome
Disallow: /trial-generation
Disallow: /claim/
Disallow: /reset-password/
Disallow: /email-verified

Sitemap: https://magicalstory.ch/sitemap.xml
```

### Step 2: Generate sitemap dynamically

Instead of a static XML file, serve the sitemap from Express so it includes all theme pages automatically.

Replace the current sitemap handler in `server.js` (~line 4997) with one that generates XML including:
- All static public pages (/, /pricing, /faq, /about, /contact, /try, /terms, /privacy, /impressum)
- `/themes` overview page
- `/themes/adventure`, `/themes/life-challenges`, `/themes/educational`, `/themes/historical` category pages
- All individual theme pages: `/themes/adventure/pirate`, `/themes/life-challenges/first-school`, etc.

**Priority values:**
- `/` → 1.0
- `/try`, `/pricing` → 0.9
- `/themes` → 0.8
- `/themes/:category` → 0.7
- `/themes/:category/:themeId` → 0.6
- `/faq`, `/about`, `/contact` → 0.5
- `/terms`, `/privacy`, `/impressum` → 0.3

### Step 3: Remove static sitemap.xml

Delete `client/public/sitemap.xml` since the server now generates it dynamically.

### Step 4: Commit

```
feat: dynamic sitemap and improved robots.txt
```

---

## Task 3: Themes Overview Page (`/themes`)

**Files:**
- Create: `client/src/pages/Themes.tsx`
- Modify: `client/src/App.tsx` (add route)
- Modify: `client/src/components/common/Footer.tsx` (add link)

### Design

A single page showing all 4 theme categories as cards, each linking to its category page. SEO-optimized header with description.

**Layout:**
```
[Navigation]

[Header: "Story Themes" with description]
"Choose from hundreds of themes or create your own story"

[4 Category Cards in 2x2 grid]
  Adventure (36 themes) → /themes/adventure
  Life Challenges (50+ themes) → /themes/life-challenges
  Educational (30+ themes) → /themes/educational
  Historical Events (70+ themes) → /themes/historical

[Popular Themes section - show 12 most popular across all categories]

[CTA: "Create Your Free Story"]

[Footer]
```

Each category card shows:
- Category icon/emoji
- Category name
- Brief description
- Theme count
- 4-6 popular theme tags as pills

### Step 1: Create the component

Trilingual. Reuse existing `storyCategories` data from `storyTypes.ts`. Show theme counts calculated from the arrays.

### Step 2: Add route and footer link

In `App.tsx`: add `/themes` and `/themes/*` routes.
In `Footer.tsx`: add "Themes" / "Themen" / "Thèmes" link.

### Step 3: Commit

```
feat: add themes overview page
```

---

## Task 4: Theme Category Pages (`/themes/:category`)

**Files:**
- Create: `client/src/pages/ThemeCategory.tsx`
- Modify: `client/src/App.tsx` (add routes)

### Design

Shows all themes within a category, grouped by subcategory.

**URL mapping:**
- `/themes/adventure` → Adventure themes (grouped: Historical Times, Fantasy, Exploration, etc.)
- `/themes/life-challenges` → Life challenges (grouped: Toddler, Preschool, Early School, etc.)
- `/themes/educational` → Educational (grouped: Letters, Numbers, Science, etc.)
- `/themes/historical` → Historical events (grouped: Swiss, Exploration, Science, etc.)

**Layout:**
```
[Navigation]

[Header with category icon]
"Adventure Stories" / "Life Challenge Stories" / etc.
[SEO description paragraph]

[Subcategory sections]
  [Subcategory heading with icon]
  [Grid of theme cards - each links to /themes/:category/:themeId]
    Theme card: emoji + name + brief text + "Create this story →"

[CTA: "Create Your Free Story"]

[Footer]
```

### Step 1: Create the component

Single component that reads `:category` param and renders the appropriate data. Uses:
- `storyTypes` + `adventureThemeGroups` for adventure
- `lifeChallenges` + `lifeChallengeGroups` for life-challenges
- `educationalTopics` + `educationalGroups` for educational
- `historicalEvents` + `historicalEventGroups` for historical

### Step 2: Add routes

```tsx
<Route path="/themes/:category" element={<ThemeCategory />} />
```

### Step 3: Commit

```
feat: add theme category pages
```

---

## Task 5: Individual Theme Pages (`/themes/:category/:themeId`)

**Files:**
- Create: `client/src/pages/ThemePage.tsx`
- Modify: `client/src/App.tsx` (add route)

### Design

Individual landing page for each theme. This is the **primary SEO page** — each one targets a specific long-tail keyword like "personalized first day of school book" or "kinderbuch zahnarztbesuch".

**Layout:**
```
[Navigation]

[Breadcrumb: Themes > Adventure > Pirate Adventure]

[Hero section]
  [Theme emoji (large)]
  [Theme name as h1]
  [SEO description paragraph - unique per theme]
  [CTA button: "Create This Story"]

[What to expect section]
  - 2-3 bullet points about what happens in this type of story
  - Age-appropriate info (for life challenges)
  - Historical context (for historical events: year, key person)

[How it works - 3 steps with icons]
  1. Upload a photo
  2. Choose this theme
  3. Get your personalized story

[Related themes section - 4-6 similar themes from same category]

[CTA: "Create Your Free Story"]

[Footer]
```

### Theme descriptions

**For adventure themes:** Generate from theme name.
- Pirate: "Set sail on the high seas! Your child becomes a brave pirate captain in this exciting adventure story."
- Dragon: "Embark on an epic quest! Your child befriends a dragon in this fantasy adventure."

**For life challenges:** Use empowerment language (per competitor research).
- First Day of School: "Starting school is a big step. Help your child feel confident with a personalized story where they're the hero of their first school day."
- New Sibling: "A new baby is coming! This story helps your child understand and get excited about becoming a big brother or sister."

**For educational:** Focus on learning outcome.
- Alphabet: "Learn the ABCs with a personalized adventure! Your child discovers each letter in a fun, illustrated story."

**For historical:** Include year, key person, educational value.
- Moon Landing (1969): "Travel back to 1969! Your child joins Neil Armstrong on humanity's greatest adventure — landing on the Moon."
- Wilhelm Tell (1307): "Experience Swiss history! Your child meets Wilhelm Tell and learns about courage and freedom."

**Important:** Theme descriptions must be in all 3 languages (EN/DE/FR). Store them in a dedicated data file or within the ThemePage component.

### Step 1: Create theme descriptions data

Create `client/src/constants/themeDescriptions.ts` with trilingual descriptions for each theme. Start with:
- All popular themes (defined in `popularAdventureThemeIds`, `popularLifeChallengeIds`, `popularEducationalTopicIds`, `popularHistoricalEventIds`)
- All historical events (user explicitly asked for these)
- Remaining themes get auto-generated descriptions from their name

### Step 2: Create the ThemePage component

Single component that reads `:category` and `:themeId` params, looks up theme data, and renders the page.

### Step 3: Add route

```tsx
<Route path="/themes/:category/:themeId" element={<ThemePage />} />
```

### Step 4: Commit

```
feat: add individual theme landing pages
```

---

## Task 6: Server-Side Theme Meta Tags

**Files:**
- Modify: `server/lib/seoMeta.js`

### Step 1: Add theme data to server

The server needs access to theme names/descriptions for meta tag injection. Options:
1. **Duplicate as plain JS** — copy theme names into `seoMeta.js` (simple, some duplication)
2. **Import from client** — use `require()` with transpilation (complex)
3. **Generate a JSON file at build time** — Vite plugin or build script (cleanest)

**Recommended: Option 1** — duplicate the essentials (id, name per language, description per language) as a plain JS object in `server/lib/seoMeta.js`. The data changes rarely.

### Step 2: Generate dynamic meta for theme routes

For `/themes/:category/:themeId`:
- Title: `"{Theme Name} – Personalized Story | Magical Story"`
- Description: theme description (first 155 chars)
- Canonical: `/themes/:category/:themeId`
- JSON-LD: Product schema with "free trial" offer

For `/themes/:category`:
- Title: `"{Category Name} Stories – Magical Story"`
- Description: category description

### Step 3: Add hreflang tags

For every public route, add:
```html
<link rel="alternate" hreflang="de" href="https://magicalstory.ch{path}" />
<link rel="alternate" hreflang="en" href="https://magicalstory.ch{path}?lang=en" />
<link rel="alternate" hreflang="fr" href="https://magicalstory.ch{path}?lang=fr" />
<link rel="alternate" hreflang="x-default" href="https://magicalstory.ch{path}" />
```

German is the default (no query param) since Switzerland is the primary market.

### Step 4: Handle `?lang=` query param

In `LanguageContext.tsx`, detect `?lang=` param on initial load and set language accordingly. This ensures that when Google crawls `?lang=en`, the page actually renders in English.

### Step 5: Commit

```
feat: server-side meta tags for all theme pages with hreflang
```

---

## Task 7: Link Landing Page to Theme Pages

**Files:**
- Modify: `client/src/pages/LandingPage.tsx`

### Step 1: Add "Browse all themes →" link

In Section 2 ("Tell Your Story"), add a link after the bullet points:

```tsx
<Link to="/themes" className="...">
  Browse all themes →
</Link>
```

### Step 2: Commit

```
feat: link landing page to themes
```

---

## Testing Checklist

After implementation, verify:

- [ ] `curl -s https://magicalstory.ch/ | grep '<title>'` → shows page-specific title
- [ ] `curl -s https://magicalstory.ch/faq | grep 'FAQPage'` → shows FAQ JSON-LD
- [ ] `curl -s https://magicalstory.ch/themes/life-challenges/first-school | grep '<title>'` → shows theme title
- [ ] `curl -s https://magicalstory.ch/sitemap.xml | wc -l` → 200+ lines (all theme pages)
- [ ] `curl -s https://magicalstory.ch/robots.txt` → blocks /admin, /create, etc.
- [ ] `curl -s https://magicalstory.ch/?lang=en | grep 'hreflang'` → shows language alternates
- [ ] `curl -s https://magicalstory.ch/themes/historical/moon-landing | grep 'og:title'` → correct OG title
- [ ] Open `/themes` in browser → category cards render
- [ ] Open `/themes/life-challenges` → all life challenge themes listed
- [ ] Open `/themes/historical/wilhelm-tell` → individual theme page renders
- [ ] Click "Create This Story" → navigates to `/try` or `/create`
- [ ] All pages render correctly in DE, EN, FR
- [ ] Google Rich Results Test passes for `/faq` (FAQPage schema)

---

## File Summary

| File | Action | Phase |
|------|--------|-------|
| `server/lib/seoMeta.js` | Create | 1 |
| `server.js` | Modify SPA handler (~line 5012) | 1 |
| `client/public/robots.txt` | Rewrite | 1 |
| `client/public/sitemap.xml` | Delete (server generates dynamically) | 1 |
| `server.js` | Modify sitemap handler (~line 4997) | 1 |
| `client/src/pages/Themes.tsx` | Create | 2 |
| `client/src/pages/ThemeCategory.tsx` | Create | 2 |
| `client/src/pages/ThemePage.tsx` | Create | 2 |
| `client/src/constants/themeDescriptions.ts` | Create | 2 |
| `client/src/App.tsx` | Add routes | 2 |
| `client/src/components/common/Footer.tsx` | Add link | 2 |
| `client/src/pages/LandingPage.tsx` | Add link to themes | 2 |
| `client/src/context/LanguageContext.tsx` | Handle `?lang=` param | 3 |
