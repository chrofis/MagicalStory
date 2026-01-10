/**
 * Landmark Photo Service
 *
 * Fetches reference photos for real-world landmarks from Wikimedia Commons / Openverse
 * to improve image generation accuracy for famous buildings, monuments, etc.
 */

const { log } = require('../utils/logger');
const { compressImageToJPEG } = require('./images');

// Simple in-memory cache (24-hour TTL)
const photoCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// ============================================================================
// WIKIPEDIA CATEGORY PARSING
// ============================================================================

/**
 * Categories that indicate tourist-worthy landmarks (get +40% score boost)
 * Patterns match against category names (case-insensitive)
 */
const BOOST_CATEGORY_PATTERNS = [
  // Tourist attractions
  /tourist.?attract/i, /visitor.?attract/i, /sehenswürdigkeit/i, /attraction.?touristique/i,
  // Castles & palaces
  /\bcastles?\b/i, /\bpalaces?\b/i, /\bschloss\b/i, /\bschlösser\b/i, /\bburg(en)?\b/i, /château/i,
  // Religious buildings
  /\bchurches?\b/i, /\bcathedrals?\b/i, /\babbeys?\b/i, /\bmonaster/i, /\bkirchen?\b/i, /\bdom\b/i, /église/i,
  // Bridges
  /\bbridges?\b/i, /\bbrücken?\b/i, /\bpont\b/i,
  // Museums & cultural
  /\bmuseums?\b/i, /\bmuseen\b/i, /\bmusée/i, /cultural.?heritage/i, /kulturerbe/i,
  // Parks & gardens
  /\bparks?\b/i, /\bgardens?\b/i, /\bgärten\b/i, /\bjardin/i,
  // Monuments & memorials
  /\bmonuments?\b/i, /\bmemorials?\b/i, /\bdenkmal/i, /\bdenkmäler/i,
  // Historic sites
  /historic.?(site|place|building|monument)/i, /historisch/i, /patrimoine/i,
  // UNESCO
  /unesco/i, /world.?heritage/i, /welterbe/i, /weltkulturerbe/i,
  // Towers & landmarks
  /\btowers?\b/i, /\bturm\b/i, /\btürme\b/i, /\btour\b/i, /landmark/i, /wahrzeichen/i,
  // Railway stations (historic)
  /railway.?station/i, /\bbahnhof\b/i, /\bgare\b/i,
  // Roman/ancient
  /roman.?(site|ruin|bath|remain)/i, /römisch/i, /romain/i, /ancient/i, /antik/i,
  // Ruins
  /\bruins?\b/i, /\bruine/i,
  // Squares & plazas
  /\bsquares?\b/i, /\bplazas?\b/i, /\bplatz\b/i, /\bplätze\b/i, /\bplace\b/i
];

/**
 * Map category keywords to human-readable landmark types
 * Order matters - first match wins
 */
const CATEGORY_TO_TYPE = [
  // Specific types first
  { pattern: /castle|schloss|burg|château/i, type: 'Castle' },
  { pattern: /palace|palast|palais/i, type: 'Palace' },
  { pattern: /cathedral|dom|kathedrale|cathédrale/i, type: 'Cathedral' },
  { pattern: /church|kirche|église/i, type: 'Church' },
  { pattern: /abbey|abtei|abbaye/i, type: 'Abbey' },
  { pattern: /monastery|kloster|monastère/i, type: 'Monastery' },
  { pattern: /chapel|kapelle|chapelle/i, type: 'Chapel' },
  { pattern: /bridge|brücke|pont/i, type: 'Bridge' },
  { pattern: /tower|turm|tour/i, type: 'Tower' },
  { pattern: /museum|musée/i, type: 'Museum' },
  { pattern: /park(?!ing)/i, type: 'Park' },
  { pattern: /garden|garten|jardin/i, type: 'Garden' },
  { pattern: /fountain|brunnen|fontaine/i, type: 'Fountain' },
  { pattern: /monument|denkmal/i, type: 'Monument' },
  { pattern: /statue|skulptur|sculpture/i, type: 'Statue' },
  { pattern: /square|platz|place(?!s?\s+in)/i, type: 'Square' },
  { pattern: /market|markt|marché/i, type: 'Market' },
  { pattern: /station|bahnhof|gare/i, type: 'Station' },
  { pattern: /theater|theatre|théâtre/i, type: 'Theatre' },
  { pattern: /library|bibliothek|bibliothèque/i, type: 'Library' },
  { pattern: /ruin|ruine/i, type: 'Ruins' },
  { pattern: /roman|römisch|romain/i, type: 'Roman site' },
  { pattern: /bath|bad|therme|bain/i, type: 'Baths' },
  { pattern: /lake|see|lac/i, type: 'Lake' },
  { pattern: /river|fluss|rivière/i, type: 'River' },
  { pattern: /mountain|berg|montagne/i, type: 'Mountain' },
  { pattern: /cave|höhle|grotte/i, type: 'Cave' },
  { pattern: /waterfall|wasserfall|cascade/i, type: 'Waterfall' },
  // Generic fallbacks
  { pattern: /historic|historisch|historique/i, type: 'Historic site' },
  { pattern: /landmark|sehenswürdigkeit|monument/i, type: 'Landmark' },
  { pattern: /building|gebäude|bâtiment/i, type: 'Building' }
];

/**
 * Fetch Wikipedia categories for a batch of page IDs
 * @param {string} lang - Wikipedia language code (e.g., 'de', 'en')
 * @param {number[]} pageIds - Array of page IDs to fetch categories for
 * @returns {Promise<Map<number, string[]>>} - Map of pageId -> category names
 */
async function fetchWikipediaCategories(lang, pageIds) {
  if (!pageIds || pageIds.length === 0) return new Map();

  const results = new Map();

  // Wikipedia API allows up to 50 page IDs per request
  const batchSize = 50;
  for (let i = 0; i < pageIds.length; i += batchSize) {
    const batch = pageIds.slice(i, i + batchSize);
    const url = `https://${lang}.wikipedia.org/w/api.php?` +
      `action=query&pageids=${batch.join('|')}` +
      `&prop=categories&cllimit=10&clshow=!hidden` +
      `&format=json&origin=*`;

    try {
      log.debug(`[LANDMARK-CAT] Fetching URL: ${url.substring(0, 100)}...`);
      const res = await fetch(url);
      const data = await res.json();

      let foundCount = 0;
      const pages = data.query?.pages || {};
      const pageKeys = Object.keys(pages);
      log.debug(`[LANDMARK-CAT] ${lang}: API returned ${pageKeys.length} pages, keys: ${pageKeys.slice(0, 5).join(',')}...`);

      for (const [pageId, page] of Object.entries(pages)) {
        const rawCategories = page.categories || [];
        const categories = rawCategories.map(c => c.title.replace(/^Category:|^Kategorie:|^Catégorie:/i, ''));
        results.set(parseInt(pageId), categories);
        if (categories.length > 0) {
          foundCount++;
          // Log first page with categories for debugging
          if (foundCount <= 2) {
            log.debug(`[LANDMARK-CAT] ${lang}: pageId=${pageId} "${page.title}" has ${categories.length} cats: ${categories.slice(0, 3).join(', ')}`);
          }
        }
      }
      log.debug(`[LANDMARK-CAT] ${lang}: ${foundCount}/${batch.length} pages have categories`);
    } catch (err) {
      log.warn(`[LANDMARK-CAT] Failed to fetch categories for ${lang}: ${err.message}`);
    }
  }

  return results;
}

/**
 * Parse categories to extract landmark type and check for boost eligibility
 * @param {string[]} categories - Array of category names
 * @returns {{ type: string|null, shouldBoost: boolean }}
 */
function parseLandmarkCategories(categories) {
  if (!categories || categories.length === 0) {
    return { type: null, shouldBoost: false };
  }

  // Check if any category matches boost patterns
  const shouldBoost = categories.some(cat =>
    BOOST_CATEGORY_PATTERNS.some(pattern => pattern.test(cat))
  );

  // Find landmark type from categories
  let type = null;
  for (const cat of categories) {
    for (const { pattern, type: matchType } of CATEGORY_TO_TYPE) {
      if (pattern.test(cat)) {
        type = matchType;
        break;
      }
    }
    if (type) break;
  }

  return { type, shouldBoost };
}

/**
 * Enrich landmarks with Wikipedia categories (type + boost flag)
 * @param {Array} landmarks - Landmarks with pageId and lang fields
 * @returns {Promise<void>} - Modifies landmarks in place
 */
async function enrichLandmarksWithCategories(landmarks) {
  // Group landmarks by language
  const byLang = new Map();
  let skippedCount = 0;
  for (const landmark of landmarks) {
    if (!landmark.pageId || !landmark.lang) {
      skippedCount++;
      continue;
    }
    if (!byLang.has(landmark.lang)) byLang.set(landmark.lang, []);
    byLang.get(landmark.lang).push(landmark);
  }

  log.info(`[LANDMARK-CAT] Enriching ${landmarks.length} landmarks (${skippedCount} skipped, no pageId/lang)`);
  log.debug(`[LANDMARK-CAT] Languages: ${Array.from(byLang.keys()).join(', ')}`);

  // Log first few landmarks with their pageIds for debugging
  const sampleLandmarks = landmarks.filter(l => l.pageId).slice(0, 5);
  log.debug(`[LANDMARK-CAT] Sample landmarks: ${sampleLandmarks.map(l => `${l.name}(${l.pageId})`).join(', ')}`);

  // Fetch categories per language in parallel
  await Promise.all(Array.from(byLang.entries()).map(async ([lang, langLandmarks]) => {
    const pageIds = langLandmarks.map(l => l.pageId);
    log.debug(`[LANDMARK-CAT] Fetching ${pageIds.length} categories from ${lang}.wikipedia (pageIds: ${pageIds.slice(0, 5).join(',')})`);
    const categoryMap = await fetchWikipediaCategories(lang, pageIds);
    log.debug(`[LANDMARK-CAT] Got ${categoryMap.size} category results from ${lang}.wikipedia`);

    for (const landmark of langLandmarks) {
      const categories = categoryMap.get(landmark.pageId) || [];
      landmark.categories = categories;
      const { type, shouldBoost } = parseLandmarkCategories(categories);
      landmark.type = type;
      landmark.shouldBoost = shouldBoost;

      // Log ALL landmarks with their categories to debug why types aren't being extracted
      if (categories.length > 0) {
        log.debug(`[LANDMARK-CAT] "${landmark.name}" (pageId=${landmark.pageId}) categories: ${categories.slice(0, 5).join(', ')}${categories.length > 5 ? '...' : ''}`);
        if (type) {
          log.info(`[LANDMARK-CAT] ✓ "${landmark.name}" → ${type}${shouldBoost ? ' 🏆' : ''}`);
        } else {
          log.debug(`[LANDMARK-CAT] ✗ "${landmark.name}" → NO TYPE MATCH`);
        }
      } else {
        log.debug(`[LANDMARK-CAT] ✗ "${landmark.name}" (pageId=${landmark.pageId}) → NO CATEGORIES RETURNED`);
      }
    }
  }));
}

/**
 * Fetch photo from Wikimedia Commons API
 * @param {string} query - Search query (e.g., "Eiffel Tower Paris")
 * @returns {Promise<{url: string, attribution: string, thumbnailUrl: string} | null>}
 */
async function fetchFromWikimedia(query) {
  try {
    // Search for images in File namespace (namespace 6), filter to common image types
    // Exclude PDFs and other documents by adding filetype filter
    const searchUrl = `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query + ' landmark filetype:jpg|jpeg|png|webp')}&srnamespace=6&srlimit=10&format=json&origin=*`;

    log.debug(`[LANDMARK] Wikimedia search: ${query}`);
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();

    if (!searchData.query?.search?.length) {
      log.debug(`[LANDMARK] Wikimedia: no results for "${query}"`);
      return null;
    }

    // Loop through results to find first actual image (not PDF/video)
    for (const result of searchData.query.search) {
      const fileName = result.title;

      // Skip non-image files by extension
      const lowerName = fileName.toLowerCase();
      if (lowerName.endsWith('.pdf') || lowerName.endsWith('.svg') ||
          lowerName.endsWith('.webm') || lowerName.endsWith('.ogv') ||
          lowerName.endsWith('.ogg') || lowerName.endsWith('.djvu')) {
        log.debug(`[LANDMARK] Skipping non-image: ${fileName}`);
        continue;
      }

      log.debug(`[LANDMARK] Wikimedia found: ${fileName}`);

      // Get image URL and metadata
      const infoUrl = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(fileName)}&prop=imageinfo&iiprop=url|user|extmetadata|mime&format=json&origin=*`;
      const infoRes = await fetch(infoUrl);
      const infoData = await infoRes.json();

      const pages = infoData.query?.pages;
      const page = pages ? Object.values(pages)[0] : null;
      const imageInfo = page?.imageinfo?.[0];

      if (!imageInfo?.url) {
        continue;
      }

      // Verify it's an actual image MIME type
      const mime = imageInfo.mime || '';
      if (!mime.startsWith('image/')) {
        log.debug(`[LANDMARK] Skipping non-image MIME: ${mime}`);
        continue;
      }

      // Use original URL - Wikimedia rate-limits thumbnail URLs (429 error)
      return {
        url: imageInfo.url,
        originalUrl: imageInfo.url,
        attribution: `Photo by ${imageInfo.user || 'Unknown'} via Wikimedia Commons`,
        license: imageInfo.extmetadata?.LicenseShortName?.value || 'CC'
      };
    }

    log.debug(`[LANDMARK] Wikimedia: no valid images found for "${query}"`);
    return null;
  } catch (err) {
    log.error(`[LANDMARK] Wikimedia API error:`, err.message);
    return null;
  }
}

/**
 * Fetch photo from Openverse API (Creative Commons catalog)
 * @param {string} query - Search query
 * @returns {Promise<{url: string, attribution: string} | null>}
 */
async function fetchFromOpenverse(query) {
  try {
    // Openverse API - search for commercially usable images
    const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&license_type=commercial&page_size=5`;

    log.debug(`[LANDMARK] Openverse search: ${query}`);
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'MagicalStory/1.0 (https://magicalstory.ch)'
      }
    });

    if (!res.ok) {
      log.debug(`[LANDMARK] Openverse API returned ${res.status}`);
      return null;
    }

    const data = await res.json();

    if (!data.results?.length) {
      log.debug(`[LANDMARK] Openverse: no results for "${query}"`);
      return null;
    }

    const image = data.results[0];
    return {
      url: image.url,
      attribution: image.attribution || `Photo via Openverse (${image.license || 'CC'})`,
      license: image.license
    };
  } catch (err) {
    log.error(`[LANDMARK] Openverse API error:`, err.message);
    return null;
  }
}

/**
 * Download image and convert to base64
 * @param {string} imageUrl - URL of image to download
 * @returns {Promise<string>} Base64 data URI
 */
async function downloadAsBase64(imageUrl) {
  try {
    log.debug(`[LANDMARK] Downloading: ${imageUrl.substring(0, 80)}...`);

    const res = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'MagicalStory/1.0 (https://magicalstory.ch)'
      }
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');

    // Determine MIME type
    let mimeType = 'image/jpeg';
    if (contentType.includes('png')) mimeType = 'image/png';
    else if (contentType.includes('webp')) mimeType = 'image/webp';
    else if (contentType.includes('gif')) mimeType = 'image/gif';

    const sizeKB = Math.round(base64.length * 0.75 / 1024);
    log.debug(`[LANDMARK] Downloaded ${sizeKB}KB image`);

    return `data:${mimeType};base64,${base64}`;
  } catch (err) {
    log.error(`[LANDMARK] Download error:`, err.message);
    throw err;
  }
}

/**
 * Fetch landmark photo with caching and fallback
 * @param {string} landmarkQuery - Search query for the landmark
 * @returns {Promise<{photoUrl: string, photoData: string, attribution: string, source: string} | null>}
 */
async function fetchLandmarkPhoto(landmarkQuery) {
  if (!landmarkQuery || typeof landmarkQuery !== 'string') {
    return null;
  }

  // Check cache first
  const cacheKey = landmarkQuery.toLowerCase().trim();
  const cached = photoCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    log.debug(`[LANDMARK] Cache hit for: "${landmarkQuery}"`);
    return cached.data;
  }

  log.info(`[LANDMARK] Fetching photo for: "${landmarkQuery}"`);

  // Try Wikimedia Commons first (best for landmarks)
  let result = await fetchFromWikimedia(landmarkQuery);
  let source = 'wikimedia';

  // Fallback to Openverse if Wikimedia fails
  if (!result) {
    log.debug(`[LANDMARK] Trying Openverse fallback...`);
    result = await fetchFromOpenverse(landmarkQuery);
    source = 'openverse';
  }

  if (!result) {
    log.warn(`[LANDMARK] No photo found for: "${landmarkQuery}"`);
    // Cache the failure to avoid repeated lookups
    photoCache.set(cacheKey, { data: null, timestamp: Date.now() });
    return null;
  }

  try {
    // Download and convert to base64
    const rawPhotoData = await downloadAsBase64(result.url);

    // Compress to reasonable size for API (768px max, 80% quality)
    const photoData = await compressImageToJPEG(rawPhotoData, 80, 768);
    const compressedSizeKB = Math.round(photoData.length * 0.75 / 1024);
    log.debug(`[LANDMARK] Compressed to ${compressedSizeKB}KB`);

    const photoResult = {
      photoUrl: result.url,
      photoData,
      attribution: result.attribution,
      source,
      license: result.license
    };

    // Cache the successful result
    photoCache.set(cacheKey, { data: photoResult, timestamp: Date.now() });

    log.info(`[LANDMARK] ✅ Fetched photo for "${landmarkQuery}" from ${source} (${compressedSizeKB}KB)`);
    return photoResult;
  } catch (err) {
    log.error(`[LANDMARK] Failed to download photo for "${landmarkQuery}":`, err.message);
    return null;
  }
}

/**
 * Pre-fetch photos for all landmarks in a Visual Bible
 * Designed to run in background as soon as landmarks are detected
 * @param {Object} visualBible - Parsed Visual Bible object
 * @returns {Promise<Object>} Updated Visual Bible with photo data
 */
async function prefetchLandmarkPhotos(visualBible) {
  if (!visualBible?.locations) {
    return visualBible;
  }

  // Find locations marked as real landmarks that don't already have photos
  // (Skip landmarks that were already linked from pre-discovered cache)
  const landmarks = visualBible.locations.filter(
    loc => loc.isRealLandmark && loc.landmarkQuery && loc.photoFetchStatus !== 'success'
  );

  if (landmarks.length === 0) {
    log.debug(`[LANDMARK] No landmarks need photo fetching (all already linked or none found)`);
    return visualBible;
  }

  log.info(`[LANDMARK] 🌍 Pre-fetching photos for ${landmarks.length} landmark(s) (skipping pre-linked)`);
  const startTime = Date.now();

  // Fetch all in parallel with Promise.allSettled (don't fail on individual errors)
  const results = await Promise.allSettled(landmarks.map(async (loc) => {
    try {
      const photo = await fetchLandmarkPhoto(loc.landmarkQuery);

      if (photo) {
        loc.referencePhotoUrl = photo.photoUrl;
        loc.referencePhotoData = photo.photoData;
        loc.photoAttribution = photo.attribution;
        loc.photoSource = photo.source;
        loc.photoFetchStatus = 'success';
        return { name: loc.name, success: true };
      } else {
        loc.photoFetchStatus = 'failed';
        return { name: loc.name, success: false };
      }
    } catch (err) {
      loc.photoFetchStatus = 'failed';
      log.error(`[LANDMARK] Error fetching photo for "${loc.name}":`, err.message);
      return { name: loc.name, success: false, error: err.message };
    }
  }));

  const elapsed = Date.now() - startTime;
  const successCount = results.filter(r => r.status === 'fulfilled' && r.value?.success).length;

  log.info(`[LANDMARK] ✅ Pre-fetch complete: ${successCount}/${landmarks.length} photos fetched in ${elapsed}ms`);

  return visualBible;
}

/**
 * Get photo count from Wikimedia Commons for a landmark
 * More photos = more photogenic/popular landmark
 * @param {string} landmarkName - Exact landmark name
 * @returns {Promise<number>} Number of photos on Commons
 */
async function getCommonsPhotoCount(landmarkName) {
  try {
    // Search Commons for exact landmark name in File namespace
    const url = `https://commons.wikimedia.org/w/api.php?action=query&list=search` +
      `&srsearch=${encodeURIComponent('"' + landmarkName + '"')}` +
      `&srnamespace=6&srlimit=1&format=json&origin=*`;

    const res = await fetch(url);
    const data = await res.json();
    return data.query?.searchinfo?.totalhits || 0;
  } catch (err) {
    log.debug(`[LANDMARK] Commons count error for "${landmarkName}":`, err.message);
    return 0;
  }
}

/**
 * Clear the photo cache (useful for testing)
 */
function clearCache() {
  photoCache.clear();
  log.debug(`[LANDMARK] Cache cleared`);
}

/**
 * Get cache statistics
 */
function getCacheStats() {
  return {
    size: photoCache.size,
    ttlMs: CACHE_TTL
  };
}

// ============================================================================
// LANDMARK DISCOVERY - Location-First Approach
// ============================================================================

/**
 * Extract clean landmark name from Wikimedia filename
 * @param {string} filename - e.g., "File:Eiffel Tower from the Champ de Mars.jpg"
 * @returns {string|null} - Clean name or null if invalid
 */
function extractLandmarkName(filename) {
  if (!filename) return null;

  let name = filename
    .replace(/^File:/i, '')
    .replace(/\.(jpg|jpeg|png|webp|gif|tif|tiff)$/i, '')
    .replace(/_/g, ' ')
    .replace(/\s*\(.*?\)\s*/g, ' ')     // Remove parentheticals
    .replace(/\s*-\s*NOAA.*$/i, '')     // Remove "- NOAA" suffix
    .replace(/\s*-\s*panoramio.*$/i, '') // Remove "- panoramio" suffix
    .replace(/\s*-\s*\d+.*$/, '')       // Remove " - 1234" suffixes
    .replace(/\s+\d{8}$/, '')           // Remove date suffixes like "20200702"
    .replace(/\s+\d{4}$/, '')           // Remove year suffixes like "2010"
    .replace(/\s+\d{5,}\s*$/, '')       // Remove number suffixes like "75005"
    .replace(/\s*,\s*.*$/, '')          // Remove ", location" suffixes
    .replace(/\s+by\s+.*$/i, '')        // Remove "by Author" suffixes
    .replace(/\s+from\s+.*$/i, '')      // Remove "from Location" suffixes
    .replace(/\s+view\s+.*$/i, '')      // Remove "view of..." suffixes
    .replace(/\s+as seen\s+.*$/i, '')   // Remove "as seen..." suffixes
    .replace(/\s+au\s+.*$/i, '')        // Remove French "au..." suffixes
    .replace(/\s+striking\s+/i, ' ')    // "Lightning striking the Eiffel" -> "Eiffel"
    .replace(/^(Lightning|Sunset|Sunrise|View|Photo|Image|Picture)\s+/i, '') // Remove prefixes
    .replace(/\s+/g, ' ')               // Normalize whitespace
    .trim();

  // Extract main landmark name if there's a clear pattern
  // "the Eiffel Tower" -> "Eiffel Tower"
  name = name.replace(/^the\s+/i, '');

  // Skip if too short, too long, or looks like a catalog ID
  if (name.length < 4 || name.length > 50) return null;
  if (/^\d+$/.test(name)) return null;
  if (/^[A-Z]{2,5}\d+/.test(name)) return null; // Skip IDs like "IMG1234"
  if (/^(ETH|LBS|SR)\s/i.test(name)) return null; // Skip archive IDs

  // Skip generic/meaningless names
  if (/^(GENERAL|DETAIL|OVERVIEW|INTERIOR|EXTERIOR)\s*\d*$/i.test(name)) return null;

  // Skip filenames that look like street addresses or file naming conventions
  // e.g., "Baden-Baden-Prinz-Weimar-Str-Nr4a"
  if (/^[A-Za-z]+-[A-Za-z]+-[A-Za-z]+-[A-Za-z]+/.test(name)) return null;
  if (/-Nr\d+[a-z]?$/i.test(name)) return null; // "-Nr4a" endings
  if (/\b(Str|Nr|Weg|Platz|Gasse)\b.*\d/i.test(name)) return null; // Street+number patterns

  return name;
}

/**
 * Search Wikipedia for landmarks/POIs near coordinates
 * Wikipedia has clean article titles (actual landmark names)
 * Searches multiple language Wikipedias for better coverage
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @param {number} radiusMeters - Search radius
 * @param {string} excludePattern - Regex pattern to exclude (e.g., "Baden-Baden" when looking for "Baden Switzerland")
 * @param {string} country - Country name (used to select which Wikipedias to search)
 * @returns {Promise<Array<{name, query, source}>>}
 */
async function searchWikipediaLandmarks(lat, lon, radiusMeters = 10000, excludePattern = null, country = null) {
  // Determine which Wikipedia languages to search based on country
  // German-speaking countries get German Wikipedia for better local coverage
  const defaultLangs = ['en'];
  const countryLower = (country || '').toLowerCase();

  let languages = defaultLangs;
  if (/switzerland|schweiz|suisse|svizzera/i.test(countryLower)) {
    languages = ['de', 'en', 'fr']; // Swiss: German, English, French
  } else if (/germany|deutschland/i.test(countryLower)) {
    languages = ['de', 'en']; // Germany: German, English
  } else if (/austria|österreich/i.test(countryLower)) {
    languages = ['de', 'en']; // Austria: German, English
  } else if (/france|frankreich/i.test(countryLower)) {
    languages = ['fr', 'en']; // France: French, English
  } else if (/italy|italien|italia/i.test(countryLower)) {
    languages = ['it', 'en']; // Italy: Italian, English
  } else if (/spain|spanien|españa/i.test(countryLower)) {
    languages = ['es', 'en']; // Spain: Spanish, English
  }

  const allLandmarks = new Map(); // Dedupe by name across languages
  const excludeRegex = excludePattern ? new RegExp(excludePattern, 'i') : null;

  // German landmark indicators (for de.wikipedia)
  // Note: No word boundaries - German compounds like "Holzbrücke" need substring matching
  // "bad" only at end (Thermalbad) to avoid matching city names like "Ennetbaden"
  const germanLandmarkIndicator = /(burg|schloss|kirche|dom|kathedrale|abtei|kloster|brücke|turm|museum|park|garten|palast|brunnen|denkmal|statue|bahnhof|theater|halle|platz|markt|tor|mauer|ruine|bad$|therme|tempel|kapelle|bibliothek|universität|schule|spital|synagoge|moschee|tunnel|pass|stadion|arena|mühle|damm|see|fluss|wasserfall|höhle|berg|gipfel|insel|leuchtturm)/i;

  // French landmark indicators (for fr.wikipedia)
  const frenchLandmarkIndicator = /(château|église|cathédrale|abbaye|monastère|pont|tour|musée|parc|jardin|palais|fontaine|monument|statue|gare|théâtre|place|marché|porte|mur|ruine|bain|therme|temple|chapelle|bibliothèque|université|école|hôpital|synagogue|mosquée|tunnel|col|stade|moulin|barrage|lac|rivière|cascade|grotte|montagne|île|phare)/i;

  for (const lang of languages) {
    const url = `https://${lang}.wikipedia.org/w/api.php?` +
      `action=query&list=geosearch` +
      `&gscoord=${lat}|${lon}` +
      `&gsradius=${Math.min(radiusMeters, 10000)}` +
      `&gslimit=50` +
      `&format=json&origin=*`;

    try {
      log.debug(`[LANDMARK] Wikipedia (${lang}) geosearch at ${lat}, ${lon}`);
      const res = await fetch(url);
      const data = await res.json();

      for (const item of data.query?.geosearch || []) {
        const name = item.title;

        // Skip if matches exclude pattern
        if (excludeRegex && excludeRegex.test(name)) {
          continue;
        }

        // Skip generic Wikipedia articles
        if (/^(List of|Category:|Template:|Wikipedia:|Liste |Kategorie:)/i.test(name)) continue;

        // Check if name contains landmark indicators (buildings, structures, natural features)
        // Use language-appropriate patterns
        let hasLandmarkIndicator = /\b(castle|church|cathedral|abbey|monastery|bridge|tower|museum|park|garden|palace|fountain|monument|statue|station|theater|theatre|hall|plaza|square|market|gate|wall|ruin|bath|spa|temple|chapel|shrine|library|university|school|hospital|synagogue|mosque|tunnel|pass|stadium|arena|aquae|thermae|mill|dam|lake|river|falls|waterfall|cave|hill|mountain|peak|island|lighthouse)\b/i.test(name);

        if (lang === 'de') {
          hasLandmarkIndicator = hasLandmarkIndicator || germanLandmarkIndicator.test(name);
        } else if (lang === 'fr') {
          hasLandmarkIndicator = hasLandmarkIndicator || frenchLandmarkIndicator.test(name);
        }

        // Skip administrative divisions (not actual landmarks)
        if (/^(Canton of|County of|District of|Municipality of|Province of|Region of|Department of|Kanton |Bezirk |Gemeinde |Canton de|Département)/i.test(name)) {
          continue;
        }

        // Skip Swiss city articles (e.g., "Baden AG", "Zürich ZH")
        if (/^[A-ZÄÖÜ][a-zäöü]+\s+(AG|ZH|BE|LU|SG|BL|BS|SO|TG|GR|VS|NE|GE|VD|TI|FR|JU|SH|AR|AI|OW|NW|GL|ZG|SZ|UR)$/i.test(name)) {
          log.debug(`[LANDMARK] Skipping Swiss city article: "${name}"`);
          continue;
        }

        // Skip entries that are just city/municipality names (end with ", Country/Region")
        // BUT keep them if they have landmark indicators (e.g., "Stein Castle, Aargau")
        if (!hasLandmarkIndicator && /,\s*(Switzerland|Germany|Austria|France|Italy|Aargau|Canton|Zurich|Bern|Basel|Schweiz|Deutschland|Österreich|Frankreich|Italien)$/i.test(name)) {
          continue;
        }

        // Skip pure municipality names - short names without descriptive words
        const wordCount = name.split(/[\s\-]+/).length;
        if (wordCount <= 2 && !hasLandmarkIndicator) {
          log.debug(`[LANDMARK] Skipping short non-landmark: "${name}"`);
          continue;
        }

        // Skip single-word names that look like place names (capitalized, no indicator)
        if (wordCount === 1 && /^[A-ZÄÖÜ][a-zäöüß]+$/.test(name) && !hasLandmarkIndicator) {
          log.debug(`[LANDMARK] Skipping single-word place name: "${name}"`);
          continue;
        }

        // Dedupe by lowercase name - keep the one with shortest distance
        const key = name.toLowerCase();
        if (!allLandmarks.has(key) || item.dist < allLandmarks.get(key).distance) {
          allLandmarks.set(key, {
            name,
            query: name,
            source: `wikipedia-${lang}`,
            distance: item.dist,
            pageId: item.pageid,  // Store for category lookup
            lang                   // Store which Wikipedia to query
          });
        }
      }

      log.debug(`[LANDMARK] Wikipedia (${lang}) found ${data.query?.geosearch?.length || 0} articles, ${allLandmarks.size} unique landmarks total`);
    } catch (err) {
      log.error(`[LANDMARK] Wikipedia (${lang}) geosearch error:`, err.message);
    }
  }

  const landmarks = Array.from(allLandmarks.values());
  log.debug(`[LANDMARK] Wikipedia found ${landmarks.length} landmarks across ${languages.length} languages`);

  // Enrich with categories (type + boost flag) - one API call per language
  if (landmarks.length > 0) {
    log.info(`[LANDMARK] 📂 CATEGORY ENRICHMENT START for ${landmarks.length} landmarks`);
    await enrichLandmarksWithCategories(landmarks);
    log.info(`[LANDMARK] 📂 CATEGORY ENRICHMENT DONE`);
    const boostedCount = landmarks.filter(l => l.shouldBoost).length;
    const typedCount = landmarks.filter(l => l.type).length;
    log.debug(`[LANDMARK] Categories: ${typedCount}/${landmarks.length} typed, ${boostedCount} boosted`);
  }

  return landmarks;
}

/**
 * Merge two landmark arrays, deduplicating by name
 * @param {Array} primary - Primary results (higher priority)
 * @param {Array} secondary - Secondary results to merge in
 * @returns {Array} Merged and deduplicated landmarks
 */
function mergeLandmarks(primary, secondary) {
  const merged = new Map();

  // Add primary first
  for (const landmark of primary) {
    merged.set(landmark.name.toLowerCase(), landmark);
  }

  // Add secondary if not already present
  for (const landmark of secondary) {
    const key = landmark.name.toLowerCase();
    if (!merged.has(key)) {
      merged.set(key, landmark);
    } else {
      // Increment photo count if duplicate
      merged.get(key).photoCount += landmark.photoCount;
    }
  }

  return Array.from(merged.values());
}

/**
 * Geocode city name to coordinates using Nominatim (OpenStreetMap)
 * @param {string} city - City name
 * @param {string} country - Country name
 * @returns {Promise<{lat: number, lon: number}|null>}
 */
async function geocodeCity(city, country) {
  const query = [city, country].filter(Boolean).join(', ');
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'MagicalStory/1.0 (https://magicalstory.ch; contact@magicalstory.ch)' }
    });

    if (!res.ok) {
      log.debug(`[LANDMARK] Nominatim returned ${res.status}`);
      return null;
    }

    const data = await res.json();

    if (data.length > 0) {
      const coords = {
        lat: parseFloat(data[0].lat),
        lon: parseFloat(data[0].lon)
      };
      log.debug(`[LANDMARK] Geocoded "${query}" to ${coords.lat}, ${coords.lon}`);
      return coords;
    }

    log.debug(`[LANDMARK] Geocoding: no results for "${query}"`);
    return null;
  } catch (err) {
    log.error(`[LANDMARK] Geocoding error for "${query}":`, err.message);
    return null;
  }
}

/**
 * Search Wikimedia Commons by geographic coordinates
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @param {number} radiusMeters - Search radius (10-10000)
 * @returns {Promise<Array<{name, query, photoCount, coordinates, source}>>}
 */
async function searchLandmarksByCoordinates(lat, lon, radiusMeters = 10000) {
  const url = `https://commons.wikimedia.org/w/api.php?` +
    `action=query&list=geosearch` +
    `&gscoord=${lat}|${lon}` +
    `&gsradius=${Math.min(radiusMeters, 10000)}` +
    `&gsnamespace=6` +
    `&gslimit=50` +
    `&format=json&origin=*`;

  try {
    log.debug(`[LANDMARK] Geosearch at ${lat}, ${lon} (radius ${radiusMeters}m)`);
    const res = await fetch(url);
    const data = await res.json();

    const landmarks = new Map();
    for (const item of data.query?.geosearch || []) {
      // Skip non-image files
      const title = item.title || '';
      if (title.match(/\.(pdf|svg|webm|ogv|ogg|djvu)$/i)) continue;

      const name = extractLandmarkName(title);
      if (!name) continue;

      const key = name.toLowerCase();
      if (!landmarks.has(key)) {
        landmarks.set(key, {
          name,
          query: name,
          photoCount: 1,
          coordinates: { lat: item.lat, lon: item.lon },
          source: 'geosearch'
        });
      } else {
        landmarks.get(key).photoCount++;
      }
    }

    const results = Array.from(landmarks.values());
    log.debug(`[LANDMARK] Geosearch found ${results.length} unique landmarks`);
    return results;
  } catch (err) {
    log.error(`[LANDMARK] Geosearch error:`, err.message);
    return [];
  }
}

/**
 * Search Wikimedia Commons for landmarks by text query
 * @param {string} city - City name
 * @param {string} country - Country name
 * @param {number} limit - Max results per query
 * @returns {Promise<Array<{name, query, photoCount, source}>>}
 */
async function searchLandmarksByText(city, country, limit = 20) {
  const location = [city, country].filter(Boolean).join(' ');
  const queries = [
    `landmarks ${location}`,
    `monuments ${city}`,
    `famous buildings ${city}`,
    `${city} landmark`,
    `${city} monument`
  ];

  const allResults = new Map();

  for (const query of queries) {
    const searchUrl = `https://commons.wikimedia.org/w/api.php?` +
      `action=query&list=search` +
      `&srsearch=${encodeURIComponent(query)}` +
      `&srnamespace=6&srlimit=${limit}` +
      `&format=json&origin=*`;

    try {
      const res = await fetch(searchUrl);
      const data = await res.json();

      for (const result of data.query?.search || []) {
        // Skip non-image files
        const title = result.title || '';
        if (title.match(/\.(pdf|svg|webm|ogv|ogg|djvu)$/i)) continue;

        const name = extractLandmarkName(title);
        if (!name) continue;

        const key = name.toLowerCase();
        if (!allResults.has(key)) {
          allResults.set(key, {
            name,
            query: `${name} ${city} ${country}`.trim(),
            photoCount: 1,
            source: 'text-search'
          });
        } else {
          allResults.get(key).photoCount++;
        }
      }
    } catch (err) {
      log.debug(`[LANDMARK] Text search error for "${query}":`, err.message);
    }
  }

  const results = Array.from(allResults.values());
  log.debug(`[LANDMARK] Text search found ${results.length} unique landmarks for "${location}"`);
  return results;
}

/**
 * Build exclude pattern for geographic disambiguation
 * e.g., "Baden" + "Switzerland" should exclude "Baden-Baden" (Germany)
 * @param {string} city - City name
 * @param {string} country - Country name
 * @returns {string|null} - Regex pattern to exclude, or null
 */
function buildExcludePattern(city, country) {
  // Known disambiguation cases
  const disambiguations = {
    // "Baden" in Switzerland should exclude "Baden-Baden" (Germany)
    'baden': country?.toLowerCase()?.includes('switzerland') ? 'Baden-Baden' : null,
    // Add more cases as needed
  };

  return disambiguations[city?.toLowerCase()] || null;
}

/**
 * Discover landmarks near a location with photo availability
 * This is the main function for location-first landmark discovery.
 *
 * Strategy:
 * 1. Geocode the city to get coordinates (ensures correct location)
 * 2. Use Wikipedia geosearch to get actual landmark names (clean titles)
 * 3. Fetch Wikipedia categories for type extraction + tourist boost
 * 4. Search Wikimedia Commons for photos of those landmarks
 * 5. Score by: (photos + photoSize) / distancePenalty * categoryBoost (+40%)
 *
 * @param {string} city - City name
 * @param {string} country - Country name
 * @param {number} limit - Max landmarks to return (default 30)
 * @returns {Promise<Array<{name, query, type, photoData, photoUrl, attribution, hasPhoto, score}>>}
 */
async function discoverLandmarksForLocation(city, country, limit = 30) {
  const location = [city, country].filter(Boolean).join(', ');
  log.info(`[LANDMARK] 🔍 Discovering landmarks near: ${location}`);
  const startTime = Date.now();

  let landmarks = [];

  // Build exclude pattern for geographic disambiguation
  const excludePattern = buildExcludePattern(city, country);
  if (excludePattern) {
    log.debug(`[LANDMARK] Using exclude pattern: ${excludePattern}`);
  }

  // Step 1: Geocode to get exact coordinates (this ensures we're in the right place)
  const coords = await geocodeCity(city, country);

  if (coords) {
    // Step 2: Use Wikipedia geosearch ONLY (clean article titles = real landmarks)
    // Don't use Wikimedia Commons geosearch - it returns messy photo filenames, not landmarks
    landmarks = await searchWikipediaLandmarks(coords.lat, coords.lon, 10000, excludePattern, country);
    log.debug(`[LANDMARK] Wikipedia geosearch found ${landmarks.length} landmarks`);
  }

  // Step 3: If geosearch failed, we could try text search but it's also unreliable
  // For now, just use what Wikipedia gave us - quality over quantity
  if (landmarks.length === 0) {
    log.warn(`[LANDMARK] Wikipedia geosearch found no landmarks for ${location}`);
  }

  // ==========================================================================
  // NEW SIMPLIFIED FLOW:
  // 1. Get photo COUNT for ALL landmarks (fast API, no download)
  // 2. Score ALL: (photoCount + categoryBonus) / distancePenalty
  // 3. Take top 30
  // 4. Download photos only for those 30
  // ==========================================================================

  // Scoring constants
  const BOOST_BONUS = 100;    // Bonus for shouldBoost (tourist attractions, castles, etc.)
  const TYPE_BONUS = 50;      // Bonus for having a type (Castle, Church, Museum, etc.)
  const BATCH_SIZE = 10;      // Process 10 landmarks at a time for photo counts
  const BATCH_DELAY_MS = 100; // 100ms delay between batches

  // Step 4: Get photo COUNT for ALL landmarks (fast - no download)
  log.info(`[LANDMARK] 📊 Getting photo counts for ${landmarks.length} landmarks...`);

  for (let i = 0; i < landmarks.length; i += BATCH_SIZE) {
    const batch = landmarks.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(batch.map(async (landmark) => {
      try {
        landmark.commonsPhotoCount = await getCommonsPhotoCount(landmark.name);
      } catch (err) {
        landmark.commonsPhotoCount = 0;
      }
    }));
    // Small delay to avoid rate limiting
    if (i + BATCH_SIZE < landmarks.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  // Step 5: Score ALL landmarks with unified formula
  // score = (photoCount + categoryBonus) / distancePenalty
  const scoredLandmarks = landmarks.map(l => {
    const photoCount = l.commonsPhotoCount || 0;
    const categoryBonus = (l.shouldBoost ? BOOST_BONUS : 0) + (l.type ? TYPE_BONUS : 0);
    const distancePenalty = 1 + (l.distance || 0) / 1000;
    const score = (photoCount + categoryBonus) / distancePenalty;
    return {
      ...l,
      score: Math.round(score)
    };
  }).sort((a, b) => b.score - a.score);

  // Log top ranked landmarks
  const boostedCount = scoredLandmarks.filter(l => l.shouldBoost).length;
  const typedCount = scoredLandmarks.filter(l => l.type).length;
  log.info(`[LANDMARK] 📊 Scored ${landmarks.length} landmarks (${boostedCount} boosted, ${typedCount} typed)`);
  log.debug(`[LANDMARK] Top 5 by score: ${scoredLandmarks.slice(0, 5).map(l =>
    `${l.name} [${l.type || '?'}]${l.shouldBoost ? '🏆' : ''} photos=${l.commonsPhotoCount} score=${l.score}`
  ).join(', ')}`);

  // Step 6: Take top N and download photos ONLY for those
  const topCandidates = scoredLandmarks.slice(0, limit + 5); // +5 buffer for photo failures
  log.info(`[LANDMARK] 📥 Downloading photos for top ${topCandidates.length} landmarks...`);

  const PHOTO_BATCH_SIZE = 5;
  const PHOTO_BATCH_DELAY_MS = 200;

  for (let i = 0; i < topCandidates.length; i += PHOTO_BATCH_SIZE) {
    const batch = topCandidates.slice(i, i + PHOTO_BATCH_SIZE);
    await Promise.allSettled(batch.map(async (landmark) => {
      try {
        const photo = await fetchLandmarkPhoto(landmark.query);
        if (photo) {
          landmark.photoData = photo.photoData;
          landmark.photoUrl = photo.photoUrl;
          landmark.attribution = photo.attribution;
          landmark.hasPhoto = true;
        } else {
          landmark.hasPhoto = false;
        }
      } catch (err) {
        landmark.hasPhoto = false;
        log.debug(`[LANDMARK] Photo fetch failed for "${landmark.name}":`, err.message);
      }
    }));
    // Delay between batches to avoid rate limiting
    if (i + PHOTO_BATCH_SIZE < topCandidates.length) {
      await new Promise(resolve => setTimeout(resolve, PHOTO_BATCH_DELAY_MS));
    }
  }

  // Filter to only those with photos, take up to limit
  const validLandmarks = withPhotos.slice(0, limit);

  const elapsed = Date.now() - startTime;
  log.info(`[LANDMARK] ✅ Discovered ${validLandmarks.length} landmarks for "${location}" in ${elapsed}ms`);
  log.info(`[LANDMARK] 📊 Stats: ${landmarks.length} from Wikipedia → ${withPhotos.length} with photos → ${validLandmarks.length} returned`);

  // Log the final landmarks
  if (validLandmarks.length > 0) {
    log.debug(`[LANDMARK] Final landmarks: ${validLandmarks.map(l =>
      `${l.name} [${l.type || '?'}]${l.shouldBoost ? '🏆' : ''} score=${l.score}`
    ).join(', ')}`);
  }

  return validLandmarks;
}

module.exports = {
  fetchLandmarkPhoto,
  prefetchLandmarkPhotos,
  discoverLandmarksForLocation,
  searchLandmarksByText,
  searchLandmarksByCoordinates,
  geocodeCity,
  clearCache,
  getCacheStats
};
