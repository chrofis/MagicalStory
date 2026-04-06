/**
 * SSR pre-render script.
 *
 * Reads the SSR bundle and the client manifest, enumerates all SEO routes
 * (× 3 languages), renders each one to a static HTML file under
 * `dist/prerendered/{path}.{lang}.html`.
 *
 * Express serves these files directly for matching routes — meaning Googlebot
 * gets fully-rendered HTML with all content visible on the first byte.
 *
 * Usage (run from project root):
 *   node scripts/prerender.mjs
 *
 * Prerequisites:
 *   1. `cd client && npm run build:client` (produces dist/ with manifest.json)
 *   2. `cd client && npm run build:ssr` (produces client/dist-ssr/entry-server.js)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// Load the existing CommonJS seoMeta module so we don't duplicate meta data.
// `getMetaForRoute` returns title/description/canonical/hreflang/JSON-LD per route.
const require = createRequire(import.meta.url);
const { getMetaForRoute, injectMeta } = require(path.join(ROOT, 'server', 'lib', 'seoMeta.js'));

// ── Paths ────────────────────────────────────────────────────────────────────
const CLIENT_DIR = path.join(ROOT, 'client');
const SSR_BUNDLE = path.join(CLIENT_DIR, 'dist-ssr', 'entry-server.js');
const DIST_DIR = path.join(ROOT, 'dist');
const MANIFEST = path.join(DIST_DIR, '.vite', 'manifest.json');
const INDEX_HTML = path.join(DIST_DIR, 'index.html');
const OUT_DIR = path.join(DIST_DIR, 'prerendered');
const SWISS_CITIES_JSON = path.join(ROOT, 'server', 'data', 'swiss-cities.json');
const SWISS_SAGEN_JSON = path.join(ROOT, 'server', 'data', 'swiss-sagen.json');
const SWISS_STORY_IDEAS_JSON = path.join(ROOT, 'server', 'data', 'swiss-story-ideas.json');

// ── Sanity checks ────────────────────────────────────────────────────────────
function assertExists(p, label) {
  if (!fs.existsSync(p)) {
    console.error(`✗ Missing ${label}: ${p}`);
    console.error('  Did you run `cd client && npm run build:client && npm run build:ssr` first?');
    process.exit(1);
  }
}
assertExists(SSR_BUNDLE, 'SSR bundle');
assertExists(MANIFEST, 'client manifest');
assertExists(INDEX_HTML, 'client index.html');
assertExists(SWISS_CITIES_JSON, 'swiss cities data');

// ── Load client data ─────────────────────────────────────────────────────────
const swissCitiesRaw = JSON.parse(fs.readFileSync(SWISS_CITIES_JSON, 'utf-8'));
const swissSagen = fs.existsSync(SWISS_SAGEN_JSON)
  ? JSON.parse(fs.readFileSync(SWISS_SAGEN_JSON, 'utf-8'))
  : { sagen: [] };
const swissStoryIdeas = fs.existsSync(SWISS_STORY_IDEAS_JSON)
  ? JSON.parse(fs.readFileSync(SWISS_STORY_IDEAS_JSON, 'utf-8'))
  : {};

// Enrich cities with their story ideas (matches the /api/swiss-stories endpoint shape)
const enrichedCities = (swissCitiesRaw.cities || []).map((city) => ({
  ...city,
  ideas: swissStoryIdeas[city.id] || [],
}));

const swissStoriesData = {
  cantons: swissCitiesRaw.cantons || {},
  cities: enrichedCities,
  sagen: swissSagen.sagen || [],
};

// ── Load index.html template (already has the hashed asset references) ──────
const indexHtmlTemplate = fs.readFileSync(INDEX_HTML, 'utf-8');

// ── Import the SSR bundle ────────────────────────────────────────────────────
const { render, enumerateRoutes } = await import(pathToFileURL(SSR_BUNDLE).href);

// ── Enumerate routes ─────────────────────────────────────────────────────────
const routes = enumerateRoutes(enrichedCities);
const LANGUAGES = ['de', 'en', 'fr'];

console.log(`📦 Pre-rendering ${routes.length} routes × ${LANGUAGES.length} languages = ${routes.length * LANGUAGES.length} files`);
console.log(`   Output: ${path.relative(ROOT, OUT_DIR)}`);

// SAGE_CITY_MAP must mirror the one in CityPage.tsx — cities with related legends.
// We use it to ship only the relevant sagen with each city page (not all 50+).
const SAGE_CITY_MAP = {
  andermatt: ['sage-devils-bridge'],
  luzern: ['sage-dragons-pilatus'],
  stgallen: ['sage-st-gall-bear'],
  basel: ['sage-vogel-gryff'],
  chur: ['sage-heidi'],
  maienfeld: ['sage-heidi'],
  zermatt: ['sage-gargantua-matterhorn'],
  altdorf: ['sage-wilhelm-tell'],
  buerglen: ['sage-wilhelm-tell'],
  sempach: ['sage-winkelried-sempach'],
  stans: ['sage-winkelried-sempach'],
};

/**
 * Build the smallest possible swissStories payload for a given route.
 * - /stadt/:cityId  → that city + nearby cities (lightweight) + matched sagen
 * - /stadt          → all cities, but no `ideas` (the listing page doesn't read them)
 * - everything else → null
 */
function buildSwissStoriesForRoute(route) {
  if (route === '/stadt') {
    // Listing page only reads name/canton/id — strip the heavy ideas[] field
    return {
      cantons: swissStoriesData.cantons,
      cities: swissStoriesData.cities.map(({ ideas, ...rest }) => ({ ...rest, ideas: [] })),
      sagen: [],
    };
  }
  const cityMatch = route.match(/^\/stadt\/(.+)$/);
  if (cityMatch) {
    const cityId = cityMatch[1];
    const city = swissStoriesData.cities.find((c) => c.id === cityId);
    if (!city) return null;
    // Nearby cities for the "Nearby" section — without their full ideas[]
    const nearby = swissStoriesData.cities.map(({ ideas, ...rest }) => ({ ...rest, ideas: [] }));
    const sageIds = SAGE_CITY_MAP[cityId] || [];
    const matchedSagen = swissStoriesData.sagen.filter((s) => sageIds.includes(s.id));
    return {
      cantons: swissStoriesData.cantons,
      cities: nearby.map((c) => (c.id === cityId ? city : c)),
      sagen: matchedSagen,
    };
  }
  return null;
}

// ── Render loop ──────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });

let written = 0;
let failed = 0;
const failures = [];
const startTime = Date.now();

for (const route of routes) {
  for (const language of LANGUAGES) {
    try {
      const swissStories = buildSwissStoriesForRoute(route);
      const seoData = swissStories ? { swissStories } : null;
      const { html: bodyHtml } = render({ url: route, language, seoData });

      // Build the initial-data payload that the client hydrates from.
      // Only include seoData if it's non-null — keeps generic page payloads tiny.
      const initialData = seoData ? { language, seoData } : { language };
      const initialDataScript = `<script>window.__INITIAL_DATA__=${
        JSON.stringify(initialData).replace(/</g, '\\u003c')
      };</script>`;

      // Inject per-route SEO meta (title, description, canonical, hreflang, JSON-LD)
      // using the same getMetaForRoute that powered the runtime injection.
      const meta = getMetaForRoute(route, language);
      let html = injectMeta(indexHtmlTemplate, meta, language);

      // Stitch the rendered React HTML into <div id="root"> and inject the
      // hydration data right after.
      html = html.replace(
        /<div id="root"><\/div>/,
        `<div id="root">${bodyHtml}</div>${initialDataScript}`
      );

      // File path: route + .{lang}.html  (root → /index.{lang}.html)
      const routePath = route === '/' ? '/index' : route;
      const filePath = path.join(OUT_DIR, `${routePath}.${language}.html`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, html);
      written++;
    } catch (err) {
      failed++;
      failures.push({ route, language, error: err.message });
      if (failures.length <= 5) {
        console.error(`✗ ${route} (${language}): ${err.message}`);
      }
    }
  }
}

const duration = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`✓ Wrote ${written} files in ${duration}s`);
if (failed > 0) {
  console.log(`✗ ${failed} failures (first 5 shown above)`);
  if (failed > 5) console.log(`  ... and ${failed - 5} more`);
}
if (failed > 0 && process.env.PRERENDER_STRICT === '1') {
  process.exit(1);
}
