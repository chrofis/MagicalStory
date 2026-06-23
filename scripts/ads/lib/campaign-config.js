/**
 * Canonical config for the MagicalStory Demand Gen + Search campaigns.
 *
 * Edit copy / budgets / URLs HERE, not in the executor.
 * Each city campaign uses the same headlines/descriptions; only the city label
 * and the geo target differ, plus the per-city creative folder.
 */

const path = require('path');

// CHF → micros: 1 CHF = 1,000,000 micros
const CHF = n => n * 1_000_000;

// Shared ad copy (Swiss German — ss not ß)
// Headlines/long-headlines/descriptions copied from existing Performance Max
// campaign 23651105239 ("Campaign Deutsch") so creative voice stays consistent.
const COPY = {
  businessName: 'Magical Story',

  // Base landing path. Per-city UTM params appended by the executor.
  // Repointed from /try → homepage 2026-06-14: /try was a thin trial page
  // converting at 0; the homepage carries the full product overview.
  finalUrlBase: 'https://magicalstory.ch/',

  // Up to 5 short headlines (≤30 chars) — picked from existing DE Performance Max ads
  headlines: [
    'Dein Kind wird zum Helden',         // 25
    'Jedes Kind hat eine Geschichte',    // 30
    'Fotos rein — Buch raus',            // 22
    'In 3 Min. zum Kinderbuch',          // 24
    'Personalisiertes Geschenk',         // 25
  ],

  // Up to 5 long headlines (≤90 chars) — from existing DE campaign
  longHeadlines: [
    'Geburtstagsgeschenk gesucht? Ein Kinderbuch, in dem dein Kind der Star ist',          // 74
    'Personalisierte Kinderbücher in unter 3 Minuten erstellen. Erste Geschichte gratis.',  // 84
    'Dein Kind als Held der eigenen Geschichte. Aus Familienfotos wird ein echtes Buch.',  // 82
    'Kinder lernen nicht durch Ermahnen. Sie lernen durch Geschichten, die sie lieben.',   // 82
  ],

  // Up to 5 descriptions (≤90 chars) — from existing DE campaign
  descriptions: [
    'Dein Kind als Held im eigenen Buch. Aus Fotos wird eine personalisierte Geschichte.',  // 83
    'Personalisierte Kinderbücher in unter 3 Minuten. Erste Geschichte gratis testen.',     // 80
    'Fotos hochladen, Thema wählen — fertig ist das personalisierte Kinderbuch',            // 74
    'Geburtstagsgeschenk gesucht? Ein Buch, in dem dein Kind der Held ist.',                // 68
    'Ein Geschenk, das kein anderes Kind hat.',                                             // 40
  ],

  callToAction: 'START_NOW', // CallToActionType enum → renders as "Jetzt starten" in DE
};

// Build final URL with per-city UTM tracking
function buildFinalUrl(cityKey, channel = 'pmax') {
  const url = new URL(COPY.finalUrlBase);
  url.searchParams.set('utm_source', 'google');
  url.searchParams.set('utm_medium', channel);
  url.searchParams.set('utm_campaign', cityKey);
  return url.toString();
}

// Per-city campaign config
const CITIES = {
  baden: {
    label: 'Baden',
    geoTargetId: 1002809, // Baden city (also works at Aargau canton 20126 if Demand Gen requires region-level)
    creativesDir: path.join(__dirname, '..', 'approved', 'baden'),
    campaignName: 'PMax-Baden-v1',
    budgetName: 'PMax-Baden-Budget-v1',
    adGroupName: 'PMax-Baden-AdGroup-v1',
  },
  aarau: {
    label: 'Aarau',
    geoTargetId: 1002807,
    creativesDir: path.join(__dirname, '..', 'approved', 'aarau'),
    campaignName: 'PMax-Aarau-v1',
    budgetName: 'PMax-Aarau-Budget-v1',
    adGroupName: 'PMax-Aarau-AdGroup-v1',
  },
  winterthur: {
    label: 'Winterthur',
    geoTargetId: 1003293,
    creativesDir: path.join(__dirname, '..', 'approved', 'winterthur'),
    campaignName: 'PMax-Winterthur-v1',
    budgetName: 'PMax-Winterthur-Budget-v1',
    adGroupName: 'PMax-Winterthur-AdGroup-v1',
  },
  luzern: {
    label: 'Luzern',
    geoTargetId: 1003056, // Lucerne city
    creativesDir: path.join(__dirname, '..', 'approved', 'luzern'),
    campaignName: 'PMax-Luzern-v1',
    budgetName: 'PMax-Luzern-Budget-v1',
    adGroupName: 'PMax-Luzern-AdGroup-v1',
  },
  schaffhausen: {
    label: 'Schaffhausen',
    geoTargetId: 1003120, // Schaffhausen city
    creativesDir: path.join(__dirname, '..', 'approved', 'schaffhausen'),
    campaignName: 'PMax-Schaffhausen-v1',
    budgetName: 'PMax-Schaffhausen-Budget-v1',
    adGroupName: 'PMax-Schaffhausen-AdGroup-v1',
  },
  stgallen: {
    label: 'St. Gallen',
    geoTargetId: 1003113, // St. Gallen city
    creativesDir: path.join(__dirname, '..', 'approved', 'st-gallen'),
    campaignName: 'PMax-St-Gallen-v1',
    budgetName: 'PMax-St-Gallen-Budget-v1',
    adGroupName: 'PMax-St-Gallen-AdGroup-v1',
  },
  biel: {
    label: 'Biel/Bienne',
    geoTargetId: 1002876, // Biel/Bienne city
    creativesDir: path.join(__dirname, '..', 'approved', 'biel'),
    campaignName: 'PMax-Biel-v1',
    budgetName: 'PMax-Biel-Budget-v1',
    adGroupName: 'PMax-Biel-AdGroup-v1',
  },
};

// Zürich Search campaign: separate from PMax (uses text ads + keywords, no creatives)
const ZURICH_SEARCH = {
  label: 'Zürich',
  geoTargetId: 20151, // Canton of Zürich (region) — widened from Zürich city 1003297
  campaignName: 'Search-Deutschschweiz-v1',
  budgetName: 'Search-Zurich-Budget-v1',
  dailyBudgetMicros: CHF(3),
  biddingStrategyType: 'TARGET_SPEND',   // Maximize Clicks
  cpcBidCeilingMicros: CHF(0.5),
  language: 'de',
  languageConstantId: 1001,
  containsEuPoliticalAdvertising: false,

  // 3 ad groups, each targeted at a different intent cluster
  adGroups: [
    {
      name: 'Personalisiertes-Kinderbuch-Zuerich',
      intent: 'Local product (Zurich + personalized children book)',
      // Match types: PHRASE = matches when query CONTAINS this phrase; EXACT = only this exact phrase
      keywords: [
        { text: 'personalisiertes kinderbuch zürich', matchType: 'PHRASE' },
        { text: 'kinderbuch personalisiert zürich',    matchType: 'PHRASE' },
        { text: 'kinderbuch mit foto zürich',          matchType: 'PHRASE' },
        { text: 'bilderbuch personalisiert zürich',    matchType: 'PHRASE' },
      ],
    },
    {
      name: 'Geschenk-Kind-Buch',
      intent: 'Gift for child (high commercial intent)',
      keywords: [
        { text: 'personalisiertes geschenk kind',       matchType: 'PHRASE' },
        { text: 'kinderbuch geschenk',                  matchType: 'PHRASE' },
        { text: 'geburtstagsgeschenk kind buch',        matchType: 'PHRASE' },
        { text: 'individuelles geschenk kind',          matchType: 'PHRASE' },
        { text: 'weihnachtsgeschenk kinderbuch',        matchType: 'PHRASE' },
      ],
    },
    {
      name: 'Bilderbuch-Mit-Eigenem-Kind',
      intent: 'Feature/format (book with own photo)',
      keywords: [
        { text: 'bilderbuch mit eigenem foto',          matchType: 'PHRASE' },
        { text: 'bilderbuch mit eigenem kind',          matchType: 'PHRASE' },
        { text: 'kind als held im buch',                matchType: 'PHRASE' },
        { text: 'personalisiertes bilderbuch',          matchType: 'PHRASE' },
        { text: 'buch mit kind als hauptfigur',         matchType: 'PHRASE' },
      ],
    },
  ],
};

// Competitor / irrelevant brand terms that triggered our Zürich Search ads but
// carry no intent for us. Added as campaign-level NEGATIVE keywords so we stop
// paying for searches for other companies' products. Match type BROAD on a
// negative keyword blocks any query CONTAINING the term.
const ZURICH_NEGATIVE_KEYWORDS = [
  'librio',       // top spender — direct competitor brand
  'globi',        // competitor brand / character
  'pixastory',    // competitor brand
  'conni',        // licensed character brand
  'paw patrol',   // licensed character brand
  'elsa',         // licensed character brand
  'bubbleboo',    // competitor brand
  'little yeti',  // competitor brand
];

// Campaign-wide defaults (per city)
const CAMPAIGN_DEFAULTS = {
  dailyBudgetMicros: CHF(3),            // CHF 3/day per city (PMax accepts CHF 3; Demand Gen required CHF 4)
  status: 'PAUSED',                      // never auto-serve; user activates in UI
  biddingStrategyType: 'MAXIMIZE_CONVERSIONS', // matches existing working PMax campaign
  language: 'de',                        // German (Switzerland's primary language for these cities)
  languageConstantId: 1001,              // Google's language constant for German
  containsEuPoliticalAdvertising: false, // required declaration
};

// Reusable assets from existing Campaign Deutsch (id 23651105239) — saves re-uploading
// the same logos / squares / business name on every PMax campaign create.
const REUSABLE_ASSETS = {
  logo:            'customers/6507339241/assets/337532317437',  // 1:1 LOGO
  landscapeLogo:   'customers/6507339241/assets/337393717742',  // 4:1 LANDSCAPE_LOGO
  squareImage:     'customers/6507339241/assets/337875585322',  // 1:1 SQUARE_MARKETING_IMAGE
  businessName:    'customers/6507339241/assets/337389367601',  // "Magical Story"
};

module.exports = { COPY, CITIES, CAMPAIGN_DEFAULTS, REUSABLE_ASSETS, ZURICH_SEARCH, ZURICH_NEGATIVE_KEYWORDS, CHF, buildFinalUrl };
