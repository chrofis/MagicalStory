# Gift-Focused SEO Pages Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 20+ gift-intent SEO landing pages targeting high-value search queries like "geschenk für enkel", "ostergeschenk kinder", "einzigartiges kindergeschenk", etc.

**Architecture:** New `/geschenk` route family following the existing `/anlass` pattern — a hub page + detail pages, with data in a constants file, SEO meta in seoMeta.js, and sitemap entries. Reuses the OccasionPage component pattern (hero + intro + tips + themes + FAQ + CTA).

**Tech Stack:** React + TypeScript (frontend), Express meta injection (backend), same trilingual DE/EN/FR pattern as existing pages.

---

## Page Structure

### Gift Pages to Create

**By Recipient (who is the gift for):**
| Slug | DE Title (H1) | Target Searches |
|------|---------------|-----------------|
| `fuer-kinder` | Einzigartiges Geschenk für Kinder | geschenk für kinder, kindergeschenk, besonderes geschenk kind |
| `fuer-enkel` | Das perfekte Geschenk für Enkel | geschenk für enkel, geschenk grosseltern an enkel, enkelin geschenk |
| `fuer-nichte-neffe` | Geschenk für Nichte & Neffe | geschenk für nichte, geschenk für neffe, geschenk tante an kind |
| `fuer-patenkind` | Geschenk für Patenkind | geschenk für patenkind, geschenk gotti götti, patengeschenk |

**By Occasion (gift-intent seasonal):**
| Slug | DE Title (H1) | Target Searches |
|------|---------------|-----------------|
| `ostergeschenk` | Ostergeschenk für Kinder | ostergeschenk kinder, ostergeschenk enkel, osternest geschenk |
| `weihnachtsgeschenk` | Weihnachtsgeschenk für Kinder | weihnachtsgeschenk kinder, weihnachtsgeschenk enkel, christkind geschenk |
| `geburtstagsgeschenk` | Geburtstagsgeschenk für Kinder | geburtstagsgeschenk kind, geburtstagsgeschenk 5 jahre, kindergeburtstag geschenk |
| `taufgeschenk` | Taufgeschenk — persönlich & unvergesslich | taufgeschenk, geschenk zur taufe, taufpate geschenk |
| `einschulungsgeschenk` | Einschulungsgeschenk | einschulungsgeschenk, geschenk zur einschulung, schulanfang geschenk |
| `nikolausgeschenk` | Nikolausgeschenk für Kinder | nikolausgeschenk, nikolaus geschenk kinder, samichlaus geschenk |

**By Attribute (what kind of gift):**
| Slug | DE Title (H1) | Target Searches |
|------|---------------|-----------------|
| `einzigartiges-geschenk` | Einzigartiges Geschenk für Kinder | einzigartiges geschenk kind, besonderes geschenk, aussergewöhnliches kindergeschenk |
| `personalisiertes-geschenk` | Personalisiertes Geschenk für Kinder | personalisiertes geschenk kind, geschenk mit namen, geschenk mit foto |
| `sinnvolles-geschenk` | Sinnvolles Geschenk für Kinder | sinnvolles geschenk kind, pädagogisches geschenk, geschenk das sinn macht |
| `last-minute-geschenk` | Last-Minute-Geschenk für Kinder | last minute geschenk kind, schnelles geschenk, geschenk sofort |

**By Age:**
| Slug | DE Title (H1) | Target Searches |
|------|---------------|-----------------|
| `geschenk-3-jahre` | Geschenk für 3-Jährige | geschenk kind 3 jahre, geschenk 3 jähriges kind |
| `geschenk-4-jahre` | Geschenk für 4-Jährige | geschenk kind 4 jahre, geschenk 4 jähriges kind |
| `geschenk-5-jahre` | Geschenk für 5-Jährige | geschenk kind 5 jahre, geschenk 5 jähriges kind |
| `geschenk-6-jahre` | Geschenk für 6-Jährige | geschenk kind 6 jahre, geschenk 6 jähriges kind |
| `geschenk-7-8-jahre` | Geschenk für 7-8-Jährige | geschenk kind 7 jahre, geschenk kind 8 jahre |

**Total: 20 pages + 1 hub = 21 new indexed URLs**

---

## Task 1: Create Gift Data Constants

**Files:**
- Create: `client/src/constants/giftData.ts`

The data structure mirrors `occasionData.ts` but with a `category` field for grouping on the hub page.

```typescript
export interface GiftPageData {
  id: string;              // URL slug
  emoji: string;
  category: 'recipient' | 'occasion' | 'attribute' | 'age';
  name: Record<'en' | 'de' | 'fr', string>;
  title: Record<'en' | 'de' | 'fr', string>;
  description: Record<'en' | 'de' | 'fr', string>;
  intro: Record<'en' | 'de' | 'fr', string>;
  tips: Record<'en' | 'de' | 'fr', string[]>;
  recommendedThemes: { id: string; category: 'adventure' | 'life-challenges' | 'educational' | 'historical' }[];
  deliveryNote: Record<'en' | 'de' | 'fr', string>;
  faq: { q: Record<'en' | 'de' | 'fr', string>; a: Record<'en' | 'de' | 'fr', string> }[];
}

export const giftPages: GiftPageData[] = [
  // ... all 20 entries
];
```

Write content for ALL 20 gift pages. Each needs:
- `name`: Short label for hub cards
- `title`: Full H1 (the titles from the table above)
- `description`: 2-3 sentence hook paragraph
- `intro`: Longer paragraph explaining why this is the perfect gift
- `tips`: 3-4 gift-giving tips specific to this category
- `recommendedThemes`: 4-6 theme IDs from existing themes that fit
- `deliveryNote`: Shipping/delivery info relevant to this gift type
- `faq`: 3-4 FAQ items targeting long-tail keywords

**Important content guidelines:**
- German is primary language, make it natural Swiss-German-friendly (not stiff Hochdeutsch)
- Use "du" form consistently
- Mention price points (ab CHF 38, kostenlos testen)
- Each page's content must be UNIQUE — no copy-paste between pages
- FAQs should target different long-tail queries per page
- Tips should be actionable and specific to the gift context
- Reference existing theme IDs from `client/src/constants/storyTypes.ts`

**Commit:** `feat: add gift page data constants (20 pages, trilingual)`

---

## Task 2: Create Gift Hub Page Component

**Files:**
- Create: `client/src/pages/GiftHub.tsx`

Follow `Occasions.tsx` pattern. Group cards by category with section headers:

```
🎁 Geschenkideen für Kinder

[Category: Für wen? (Recipient)]
  [Card: Für Kinder] [Card: Für Enkel] [Card: Für Patenkind] [Card: Für Nichte/Neffe]

[Category: Zum Anlass (Seasonal)]
  [Card: Ostergeschenk] [Card: Weihnachtsgeschenk] [Card: Geburtstag] ...

[Category: Besondere Geschenke (Attribute)]
  [Card: Einzigartig] [Card: Personalisiert] [Card: Sinnvoll] [Card: Last-Minute]

[Category: Nach Alter (Age)]
  [Card: 3 Jahre] [Card: 4 Jahre] [Card: 5 Jahre] [Card: 6 Jahre] [Card: 7-8 Jahre]
```

- Import `giftPages` from `@/constants/giftData`
- Group by `category` field
- Each card links to `/geschenk/{id}`
- Trilingual (use `useLanguage()` context)
- Include Navigation + Footer

**Commit:** `feat: add gift hub page component`

---

## Task 3: Create Gift Detail Page Component

**Files:**
- Create: `client/src/pages/GiftPage.tsx`

Follow `OccasionPage.tsx` pattern exactly. Same sections:
1. Breadcrumb: Home → Geschenkideen → {Page Title}
2. Hero: emoji + title + description + CTA button
3. "Warum" section with intro text
4. Tips section with checkmarks
5. Recommended themes cards (link to `/themes/{category}/{id}`)
6. Delivery note banner
7. FAQ accordion
8. Final CTA section

- Use `useParams()` to get `giftSlug`
- Look up in `giftPages` array by `id`
- Redirect to `/geschenk` if not found
- Trilingual

**Commit:** `feat: add gift detail page component`

---

## Task 4: Add Frontend Routes

**Files:**
- Modify: `client/src/App.tsx`

Add lazy imports and routes:

```tsx
const GiftHub = lazy(() => import('./pages/GiftHub'));
const GiftPage = lazy(() => import('./pages/GiftPage'));

// In the Routes section, near the /anlass routes:
<Route path="/geschenk" element={<GiftHub />} />
<Route path="/geschenk/:giftSlug" element={<GiftPage />} />
```

**Commit:** `feat: add gift page routes`

---

## Task 5: Add SEO Meta Tags

**Files:**
- Modify: `server/lib/seoMeta.js`

### 5a: Add GIFT_PAGES object (near OCCASIONS ~line 484)

```javascript
const GIFT_PAGES = {
  'fuer-kinder': { de: 'Einzigartiges Geschenk für Kinder', en: 'Unique Gift for Kids', fr: 'Cadeau unique pour enfants' },
  'fuer-enkel': { de: 'Das perfekte Geschenk für Enkel', en: 'The Perfect Gift for Grandchildren', fr: 'Le cadeau parfait pour les petits-enfants' },
  'fuer-nichte-neffe': { de: 'Geschenk für Nichte & Neffe', en: 'Gift for Niece & Nephew', fr: 'Cadeau pour nièce et neveu' },
  'fuer-patenkind': { de: 'Geschenk für Patenkind', en: 'Gift for Godchild', fr: 'Cadeau pour filleul(e)' },
  'ostergeschenk': { de: 'Ostergeschenk für Kinder', en: 'Easter Gift for Kids', fr: 'Cadeau de Pâques pour enfants' },
  'weihnachtsgeschenk': { de: 'Weihnachtsgeschenk für Kinder', en: 'Christmas Gift for Kids', fr: 'Cadeau de Noël pour enfants' },
  'geburtstagsgeschenk': { de: 'Geburtstagsgeschenk für Kinder', en: 'Birthday Gift for Kids', fr: 'Cadeau d\'anniversaire pour enfants' },
  'taufgeschenk': { de: 'Taufgeschenk — persönlich & unvergesslich', en: 'Baptism Gift — Personal & Unforgettable', fr: 'Cadeau de baptême — personnel & inoubliable' },
  'einschulungsgeschenk': { de: 'Einschulungsgeschenk für Kinder', en: 'First Day of School Gift', fr: 'Cadeau de rentrée scolaire' },
  'nikolausgeschenk': { de: 'Nikolausgeschenk für Kinder', en: 'St. Nicholas Gift for Kids', fr: 'Cadeau de Saint-Nicolas pour enfants' },
  'einzigartiges-geschenk': { de: 'Einzigartiges Geschenk für Kinder', en: 'Unique Gift for Kids', fr: 'Cadeau unique pour enfants' },
  'personalisiertes-geschenk': { de: 'Personalisiertes Geschenk für Kinder', en: 'Personalized Gift for Kids', fr: 'Cadeau personnalisé pour enfants' },
  'sinnvolles-geschenk': { de: 'Sinnvolles Geschenk für Kinder', en: 'Meaningful Gift for Kids', fr: 'Cadeau éducatif pour enfants' },
  'last-minute-geschenk': { de: 'Last-Minute-Geschenk für Kinder', en: 'Last-Minute Gift for Kids', fr: 'Cadeau de dernière minute pour enfants' },
  'geschenk-3-jahre': { de: 'Geschenk für 3-Jährige', en: 'Gift for 3-Year-Olds', fr: 'Cadeau pour enfant de 3 ans' },
  'geschenk-4-jahre': { de: 'Geschenk für 4-Jährige', en: 'Gift for 4-Year-Olds', fr: 'Cadeau pour enfant de 4 ans' },
  'geschenk-5-jahre': { de: 'Geschenk für 5-Jährige', en: 'Gift for 5-Year-Olds', fr: 'Cadeau pour enfant de 5 ans' },
  'geschenk-6-jahre': { de: 'Geschenk für 6-Jährige', en: 'Gift for 6-Year-Olds', fr: 'Cadeau pour enfant de 6 ans' },
  'geschenk-7-8-jahre': { de: 'Geschenk für 7–8-Jährige', en: 'Gift for 7-8-Year-Olds', fr: 'Cadeau pour enfant de 7-8 ans' },
};
```

### 5b: Add hub page to STATIC_ROUTES

```javascript
'/geschenk': {
  title: {
    de: 'Geschenkideen für Kinder | Personalisierte Kinderbücher | MagicalStory',
    en: 'Gift Ideas for Kids | Personalized Children\'s Books | MagicalStory',
    fr: 'Idées cadeaux pour enfants | Livres personnalisés | MagicalStory',
  },
  description: {
    de: 'Finde das perfekte Geschenk für Kinder: einzigartige, personalisierte Kinderbücher mit dem Foto deines Kindes. Für Enkel, Patenkinder, zu Weihnachten, Ostern & mehr.',
    en: 'Find the perfect gift for kids: unique, personalized children\'s books with your child\'s photo. For grandkids, godchildren, Christmas, Easter & more.',
    fr: 'Trouvez le cadeau parfait pour enfants: livres personnalisés uniques avec la photo de votre enfant. Pour petits-enfants, filleuls, Noël, Pâques et plus.',
  },
},
```

### 5c: Add route matching (near the occasion matching ~line 845)

```javascript
// 7. Gift page: /geschenk/:giftSlug
const giftMatch = cleanPath.match(/^\/geschenk\/([^/]+)$/);
if (giftMatch) {
  const giftSlug = giftMatch[1];
  const giftPage = GIFT_PAGES[giftSlug];
  if (giftPage) {
    const title = giftPage[lang] || giftPage.de;
    return {
      title: `${title} | MagicalStory`,
      description: buildGiftDescription(giftSlug, lang),
      canonical: `${BASE_URL}${cleanPath}`,
      path: cleanPath,
      noindex: false,
      hreflang: buildHreflang(cleanPath),
      jsonLd: [
        PRODUCT_JSON_LD,
        buildBreadcrumbJsonLd([
          { name: 'Home', url: '/' },
          { name: lang === 'de' ? 'Geschenkideen' : lang === 'fr' ? 'Idées cadeaux' : 'Gift Ideas', url: '/geschenk' },
          { name: title },
        ]),
      ],
    };
  }
}
```

### 5d: Add buildGiftDescription function

Each gift page gets a UNIQUE meta description targeting the specific search intent. Not a generic template — hand-craft for each slug to maximize keyword coverage.

### 5e: Add gift pages to sitemap

```javascript
// Gift pages
for (const giftSlug of Object.keys(GIFT_PAGES)) {
  paths.push({
    path: `/geschenk/${giftSlug}`,
    lastmod: today,
    changefreq: 'monthly',
    priority: '0.7',  // Higher than occasions (0.6) — gift intent is higher conversion
  });
}
```

Add hub to priority map: `'/geschenk': '0.8'`

**Commit:** `feat: add SEO meta tags and sitemap entries for gift pages`

---

## Task 6: Add Internal Links

**Files:**
- Modify: `client/src/pages/Occasions.tsx` — Add a banner/link section pointing to `/geschenk`
- Modify: `client/src/pages/LandingPage.tsx` — Add gift section or link in the features area
- Modify: `client/src/components/common/Footer.tsx` — Add "Geschenkideen" link in footer navigation

Internal linking is critical for SEO. The gift hub should be reachable from:
1. Footer (permanent link)
2. Landing page (gift section or feature card)
3. Occasion pages (cross-link: "Mehr Geschenkideen →")

**Commit:** `feat: add internal links to gift pages`

---

## Task 7: Build and Verify

1. `cd client && npm run build` — verify no build errors
2. `node -c server/lib/seoMeta.js` — verify no syntax errors
3. Check sitemap output includes all gift pages
4. Verify meta injection works for a sample gift route
5. Count total new indexed pages (should be 21)

**Commit:** `chore: verify gift pages build and SEO integration`

---

## Expected SEO Impact

**New indexed pages:** 21 (hub + 20 detail)
**New keyword targets:** ~60 (3 per page average)
**High-value queries covered:**
- "geschenk für enkel" (grandparent segment — high intent, high AOV)
- "ostergeschenk kinder" (seasonal — timely for spring)
- "einzigartiges geschenk kind" (attribute — differentiator)
- "geschenk kind 5 jahre" (age-specific — very common search pattern)
- "taufgeschenk" (life event — high emotional value)
- "last minute geschenk kind" (urgency — digital delivery advantage)

**Cross-linking bonus:** Gift pages link to theme pages → boosts theme page authority too.
