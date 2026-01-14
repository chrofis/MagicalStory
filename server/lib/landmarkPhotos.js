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

// Wikipedia/Wikimedia API headers - REQUIRED or they return HTML error pages
const WIKI_HEADERS = {
  'User-Agent': 'MagicalStory/1.0 (https://magicalstory.ch; contact@magicalstory.ch) Node.js',
  'Accept': 'application/json'
};

// ============================================================================
// WIKIPEDIA CATEGORY PARSING
// ============================================================================

/**
 * HIGH BOOST categories (+100 points) - Most tourist-worthy landmarks
 */
const HIGH_BOOST_PATTERNS = [
  // Tourist attractions
  /tourist.?attract/i, /visitor.?attract/i, /sehenswürdigkeit/i, /attraction.?touristique/i,
  // Castles & palaces
  /\bcastles?\b/i, /\bpalaces?\b/i, /\bschloss\b/i, /\bschlösser\b/i, /\bburg(en)?\b/i, /château/i,
  // Religious buildings
  /\bchurches?\b/i, /\bcathedrals?\b/i, /\babbeys?\b/i, /\bmonaster/i, /\bkirchen?\b/i, /\bdom\b/i, /église/i,
  // Bridges
  /\bbridges?\b/i, /\bbrücken?\b/i, /\bpont\b/i,
  // Towers
  /\btowers?\b/i, /\bturm\b/i, /\btürme\b/i, /\btour\b/i, /wahrzeichen/i
];

/**
 * MEDIUM BOOST categories (+50 points) - Good landmarks
 */
const MEDIUM_BOOST_PATTERNS = [
  // Parks & gardens
  /\bparks?\b/i, /\bgardens?\b/i, /\bgärten\b/i, /\bjardin/i,
  // Monuments & memorials
  /\bmonuments?\b/i, /\bmemorials?\b/i, /\bdenkmal/i, /\bdenkmäler/i,
  // Historic sites
  /historic.?(site|place|building|monument)/i, /historisch/i, /patrimoine/i,
  // UNESCO
  /unesco/i, /world.?heritage/i, /welterbe/i, /weltkulturerbe/i,
  // Landmarks (generic)
  /landmark/i
];

// NOT BOOSTED: museums, railway stations, roman/ancient, ruins, squares

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
  { pattern: /\bbaths?\b|\bbad\b|therme|thermalbad|\bbain/i, type: 'Baths' },
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
 * Fetch Wikidata Q-IDs for a batch of Wikipedia page IDs
 * Q-IDs are universal identifiers that are the same across all language editions
 * e.g., "Bundeshaus" (de) and "Federal Palace" (en) both have Q213207
 * @param {string} lang - Wikipedia language code (e.g., 'de', 'en')
 * @param {number[]} pageIds - Array of page IDs to fetch Q-IDs for
 * @returns {Promise<Map<number, string>>} - Map of pageId -> Wikidata Q-ID
 */
async function fetchWikidataIds(lang, pageIds) {
  if (!pageIds || pageIds.length === 0) return new Map();

  const results = new Map();
  const batchSize = 50;

  for (let i = 0; i < pageIds.length; i += batchSize) {
    const batch = pageIds.slice(i, i + batchSize);
    const url = `https://${lang}.wikipedia.org/w/api.php?` +
      `action=query&pageids=${batch.join('|')}` +
      `&prop=pageprops&ppprop=wikibase_item` +
      `&format=json&origin=*`;

    try {
      const res = await fetch(url, { headers: WIKI_HEADERS });
      const data = await res.json();

      const pages = data.query?.pages || {};
      for (const [pageId, page] of Object.entries(pages)) {
        const qid = page.pageprops?.wikibase_item;
        if (qid) {
          results.set(parseInt(pageId), qid);
        }
      }
    } catch (err) {
      log.warn(`[LANDMARK-QID] Failed to fetch Wikidata IDs for ${lang}: ${err.message}`);
    }
  }

  return results;
}

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
      `&prop=categories&cllimit=500&clshow=!hidden` +
      `&format=json&origin=*`;

    try {
      log.debug(`[LANDMARK-CAT] Fetching URL: ${url.substring(0, 100)}...`);
      const res = await fetch(url, { headers: WIKI_HEADERS });
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
 * Parse categories to extract landmark type and boost amount
 * @param {string[]} categories - Array of category names
 * @returns {{ type: string|null, boostAmount: number }}
 */
function parseLandmarkCategories(categories) {
  if (!categories || categories.length === 0) {
    return { type: null, boostAmount: 0 };
  }

  // Check for HIGH boost (+100): tourist, castles, religious, bridges, towers
  const hasHighBoost = categories.some(cat =>
    HIGH_BOOST_PATTERNS.some(pattern => pattern.test(cat))
  );

  // Check for MEDIUM boost (+50): parks, monuments, historic, UNESCO
  const hasMediumBoost = !hasHighBoost && categories.some(cat =>
    MEDIUM_BOOST_PATTERNS.some(pattern => pattern.test(cat))
  );

  const boostAmount = hasHighBoost ? 100 : (hasMediumBoost ? 50 : 0);

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

  return { type, boostAmount };
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
      const { type, boostAmount } = parseLandmarkCategories(categories);
      landmark.type = type;
      landmark.boostAmount = boostAmount;

      // Log ALL landmarks with their categories to debug why types aren't being extracted
      if (categories.length > 0) {
        log.debug(`[LANDMARK-CAT] "${landmark.name}" (pageId=${landmark.pageId}) categories: ${categories.slice(0, 5).join(', ')}${categories.length > 5 ? '...' : ''}`);
        if (type) {
          const boostLabel = boostAmount === 100 ? '🏆+100' : (boostAmount === 50 ? '⭐+50' : '');
          log.info(`[LANDMARK-CAT] ✓ "${landmark.name}" → ${type} ${boostLabel}`);
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
    const searchRes = await fetch(searchUrl, { headers: WIKI_HEADERS });
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
      const infoRes = await fetch(infoUrl, { headers: WIKI_HEADERS });
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
 * Fetch the main image from a Wikipedia article using pageimages API
 * This is more accurate than searching by name because we use the exact pageId
 * @param {string} lang - Wikipedia language code (e.g., 'de', 'en')
 * @param {number} pageId - Wikipedia page ID
 * @returns {Promise<{url: string, attribution: string, license: string} | null>}
 */
async function fetchWikipediaArticleImage(lang, pageId) {
  try {
    const url = `https://${lang}.wikipedia.org/w/api.php?` +
      `action=query&pageids=${pageId}` +
      `&prop=pageimages&piprop=original` +
      `&format=json&origin=*`;

    log.debug(`[LANDMARK] Wikipedia article image: ${lang}:${pageId}`);
    const res = await fetch(url, { headers: WIKI_HEADERS });
    const data = await res.json();

    const page = data.query?.pages?.[pageId];
    if (!page?.original?.source) {
      log.debug(`[LANDMARK] Wikipedia article has no image: ${lang}:${pageId}`);
      return null;
    }

    log.debug(`[LANDMARK] Wikipedia article image found: ${page.original.source.substring(0, 80)}...`);
    return {
      url: page.original.source,
      attribution: `Image from Wikipedia (${lang})`,
      license: 'CC'
    };
  } catch (err) {
    log.error(`[LANDMARK] Wikipedia article image error:`, err.message);
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
 * @param {number} [pageId] - Wikipedia page ID (for accurate article image lookup)
 * @param {string} [lang] - Wikipedia language code (e.g., 'de', 'en')
 * @returns {Promise<{photoUrl: string, photoData: string, attribution: string, source: string} | null>}
 */
async function fetchLandmarkPhoto(landmarkQuery, pageId = null, lang = null) {
  if (!landmarkQuery || typeof landmarkQuery !== 'string') {
    return null;
  }

  // Check cache first (include pageId in cache key if available for specificity)
  const cacheKey = pageId ? `${lang}:${pageId}` : landmarkQuery.toLowerCase().trim();
  const cached = photoCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    log.debug(`[LANDMARK] Cache hit for: "${landmarkQuery}"`);
    return cached.data;
  }

  log.info(`[LANDMARK] Fetching photo for: "${landmarkQuery}"${pageId ? ` (${lang}:${pageId})` : ''}`);

  let result = null;
  let source = null;

  // PRIORITY 1: Try Wikipedia article image (most accurate - uses exact pageId)
  if (pageId && lang) {
    result = await fetchWikipediaArticleImage(lang, pageId);
    source = 'wikipedia-article';
  }

  // PRIORITY 2: Fallback to Wikimedia Commons search
  if (!result) {
    result = await fetchFromWikimedia(landmarkQuery);
    source = 'wikimedia';
  }

  // PRIORITY 3: Fallback to Openverse
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
 * Analyze a landmark photo using Gemini vision to get an accurate description
 * This runs during discovery and is cached with the landmark data
 * Cost: ~$0.00012 per photo (basically free)
 * @param {string} photoData - Base64 data URI of the photo
 * @param {string} landmarkName - Name of the landmark for context
 * @param {string} landmarkType - Type of landmark (Castle, Church, etc.)
 * @returns {Promise<string|null>} - Description of what's in the photo, or null on error
 */
async function analyzeLandmarkPhoto(photoData, landmarkName, landmarkType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    log.warn('[LANDMARK-ANALYZE] No Gemini API key, skipping photo analysis');
    return null;
  }

  if (!photoData || !photoData.startsWith('data:image/')) {
    return null;
  }

  try {
    // Extract base64 data and mime type
    const matches = photoData.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!matches) {
      log.debug('[LANDMARK-ANALYZE] Invalid photo data format');
      return null;
    }
    const [, mimeType, base64Data] = matches;

    const prompt = `Describe this photo of "${landmarkName}"${landmarkType ? ` (a ${landmarkType})` : ''} for use in children's book illustration.

Focus on:
- The main architectural/natural features visible
- Colors, materials, textures
- Distinctive elements that make it recognizable
- The setting/surroundings visible in the photo

Write 2-3 sentences. Be specific and visual. Do NOT mention the photo itself or use phrases like "The image shows".`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType,
                data: base64Data
              }
            }
          ]
        }],
        generationConfig: {
          maxOutputTokens: 200,
          temperature: 0.3
        }
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      log.debug(`[LANDMARK-ANALYZE] Gemini API error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const description = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!description) {
      log.debug(`[LANDMARK-ANALYZE] No description returned for "${landmarkName}"`);
      return null;
    }

    log.debug(`[LANDMARK-ANALYZE] ✅ "${landmarkName}": ${description.substring(0, 60)}...`);
    return description;
  } catch (err) {
    log.debug(`[LANDMARK-ANALYZE] Error for "${landmarkName}": ${err.message}`);
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

    const res = await fetch(url, { headers: WIKI_HEADERS });
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
 * Uses Wikidata Q-IDs to deduplicate across languages (same landmark, different names)
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

  // Language priority for deduplication (prefer German names for Swiss/German content)
  const langPriority = { 'de': 1, 'en': 2, 'fr': 3, 'it': 4, 'es': 5 };

  const allCandidates = []; // Collect all candidates first, dedupe later by Q-ID
  const excludeRegex = excludePattern ? new RegExp(excludePattern, 'i') : null;

  // German landmark indicators (for de.wikipedia)
  // Note: No word boundaries - German compounds like "Holzbrücke" need substring matching
  // "bad" only at end (Thermalbad) to avoid matching city names like "Ennetbaden"
  const germanLandmarkIndicator = /(burg|schloss|kirche|dom|kathedrale|abtei|kloster|brücke|turm|museum|park|garten|palast|brunnen|denkmal|statue|bahnhof|theater|halle|platz|markt|tor|mauer|ruine|bad$|therme|tempel|kapelle|bibliothek|universität|schule|spital|synagoge|moschee|tunnel|pass|stadion|arena|mühle|damm|see|fluss|wasserfall|höhle|berg|gipfel|insel|leuchtturm)/i;

  // French landmark indicators (for fr.wikipedia)
  const frenchLandmarkIndicator = /(château|église|cathédrale|abbaye|monastère|pont|tour|musée|parc|jardin|palais|fontaine|monument|statue|gare|théâtre|place|marché|porte|mur|ruine|bain|therme|temple|chapelle|bibliothèque|université|école|hôpital|synagogue|mosquée|tunnel|col|stade|moulin|barrage|lac|rivière|cascade|grotte|montagne|île|phare)/i;

  // PHASE 1: Collect candidates from all languages
  for (const lang of languages) {
    const url = `https://${lang}.wikipedia.org/w/api.php?` +
      `action=query&list=geosearch` +
      `&gscoord=${lat}|${lon}` +
      `&gsradius=${Math.min(radiusMeters, 10000)}` +
      `&gslimit=50` +
      `&format=json&origin=*`;

    try {
      log.debug(`[LANDMARK] Wikipedia (${lang}) geosearch at ${lat}, ${lon}`);
      const res = await fetch(url, { headers: WIKI_HEADERS });
      const data = await res.json();

      const langCandidates = [];
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

        langCandidates.push({
          name,
          query: name,
          source: `wikipedia-${lang}`,
          distance: item.dist,
          pageId: item.pageid,
          lang
        });
      }

      // Fetch Wikidata Q-IDs for this language batch
      if (langCandidates.length > 0) {
        const pageIds = langCandidates.map(l => l.pageId);
        const qidMap = await fetchWikidataIds(lang, pageIds);

        for (const candidate of langCandidates) {
          candidate.qid = qidMap.get(candidate.pageId) || null;
          allCandidates.push(candidate);
        }
      }

      log.debug(`[LANDMARK] Wikipedia (${lang}) found ${langCandidates.length} candidates`);
    } catch (err) {
      log.error(`[LANDMARK] Wikipedia (${lang}) geosearch error:`, err.message);
    }
  }

  // PHASE 2: Deduplicate by Wikidata Q-ID
  // Same Q-ID = same landmark in different languages (e.g., "Bundeshaus" = "Palais fédéral")
  const byQid = new Map();
  const noQid = [];

  for (const candidate of allCandidates) {
    if (candidate.qid) {
      if (!byQid.has(candidate.qid)) {
        byQid.set(candidate.qid, []);
      }
      byQid.get(candidate.qid).push(candidate);
    } else {
      // No Q-ID - dedupe by name instead
      noQid.push(candidate);
    }
  }

  // Build deduplicated list: for each Q-ID, pick the preferred language variant
  const deduplicated = [];
  let duplicateCount = 0;

  for (const [qid, variants] of byQid.entries()) {
    if (variants.length > 1) {
      duplicateCount++;
      log.debug(`[LANDMARK] 🔗 ${qid}: ${variants.map(v => `${v.name}(${v.lang})`).join(' = ')}`);
    }

    // Sort by language priority and pick first (prefer German, then English, etc.)
    variants.sort((a, b) => (langPriority[a.lang] || 99) - (langPriority[b.lang] || 99));
    const best = variants[0];

    // Store all language variants for reference
    best.variants = variants.map(v => ({ name: v.name, lang: v.lang }));
    deduplicated.push(best);
  }

  // Add landmarks without Q-ID (dedupe by name)
  const noQidDeduped = new Map();
  for (const candidate of noQid) {
    const key = candidate.name.toLowerCase();
    if (!noQidDeduped.has(key) || candidate.distance < noQidDeduped.get(key).distance) {
      noQidDeduped.set(key, candidate);
    }
  }
  deduplicated.push(...noQidDeduped.values());

  log.info(`[LANDMARK] 🔄 Wikidata dedup: ${allCandidates.length} candidates → ${deduplicated.length} unique (${duplicateCount} duplicates merged)`);

  // Enrich with categories (type + boost flag) - one API call per language
  if (deduplicated.length > 0) {
    log.info(`[LANDMARK] 📂 CATEGORY ENRICHMENT START for ${deduplicated.length} landmarks`);
    await enrichLandmarksWithCategories(deduplicated);
    log.info(`[LANDMARK] 📂 CATEGORY ENRICHMENT DONE`);
    const highBoostCount = deduplicated.filter(l => l.boostAmount === 100).length;
    const medBoostCount = deduplicated.filter(l => l.boostAmount === 50).length;
    const typedCount = deduplicated.filter(l => l.type).length;
    log.debug(`[LANDMARK] Categories: ${typedCount}/${deduplicated.length} typed, ${highBoostCount} high boost, ${medBoostCount} med boost`);
  }

  return deduplicated;
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
    const res = await fetch(url, { headers: WIKI_HEADERS });
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
      const res = await fetch(searchUrl, { headers: WIKI_HEADERS });
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

  // Scoring constants - boostAmount comes from categories (+100 high, +50 medium, 0 none)
  const TYPE_BONUS = 30;      // Extra bonus for having a type (Castle, Church, Museum, etc.)
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
  // score = (photoCount + boostAmount + typeBonus) / distancePenalty
  // boostAmount: +100 (high: tourist, castles, religious, bridges, towers)
  //              +50 (medium: parks, monuments, historic, UNESCO)
  //              +0 (none: museums, stations, ruins, squares)
  const scoredLandmarks = landmarks.map(l => {
    const photoCount = l.commonsPhotoCount || 0;
    const boostAmount = l.boostAmount || 0;
    const typeBonus = l.type ? TYPE_BONUS : 0;
    const distancePenalty = 1 + (l.distance || 0) / 1000;
    const score = (photoCount + boostAmount + typeBonus) / distancePenalty;
    return {
      ...l,
      score: Math.round(score)
    };
  }).sort((a, b) => b.score - a.score);

  // Log top ranked landmarks
  const highBoostCount = scoredLandmarks.filter(l => l.boostAmount === 100).length;
  const medBoostCount = scoredLandmarks.filter(l => l.boostAmount === 50).length;
  const typedCount = scoredLandmarks.filter(l => l.type).length;
  log.info(`[LANDMARK] 📊 Scored ${landmarks.length} landmarks (${highBoostCount} high boost, ${medBoostCount} med boost, ${typedCount} typed)`);
  log.debug(`[LANDMARK] Top 5 by score: ${scoredLandmarks.slice(0, 5).map(l => {
    const boostLabel = l.boostAmount === 100 ? '🏆' : (l.boostAmount === 50 ? '⭐' : '');
    return `${l.name} [${l.type || '?'}]${boostLabel} photos=${l.commonsPhotoCount} boost=${l.boostAmount} score=${l.score}`;
  }).join(', ')}`);

  // Step 6: Take top N and download photos ONLY for those
  const topCandidates = scoredLandmarks.slice(0, limit + 5); // +5 buffer for photo failures
  log.info(`[LANDMARK] 📥 Downloading photos for top ${topCandidates.length} landmarks...`);

  const PHOTO_BATCH_SIZE = 5;
  const PHOTO_BATCH_DELAY_MS = 200;

  for (let i = 0; i < topCandidates.length; i += PHOTO_BATCH_SIZE) {
    const batch = topCandidates.slice(i, i + PHOTO_BATCH_SIZE);
    await Promise.allSettled(batch.map(async (landmark) => {
      try {
        const photo = await fetchLandmarkPhoto(landmark.query, landmark.pageId, landmark.lang);
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
  const withPhotos = topCandidates.filter(l => l.hasPhoto);
  const validLandmarks = withPhotos.slice(0, limit);

  // Step 7: Analyze photos to get accurate descriptions (runs in parallel, ~$0.0001 per photo)
  log.info(`[LANDMARK] 🔍 Analyzing ${validLandmarks.length} landmark photos...`);
  const ANALYZE_BATCH_SIZE = 5;
  const ANALYZE_BATCH_DELAY_MS = 100;

  for (let i = 0; i < validLandmarks.length; i += ANALYZE_BATCH_SIZE) {
    const batch = validLandmarks.slice(i, i + ANALYZE_BATCH_SIZE);
    await Promise.allSettled(batch.map(async (landmark) => {
      if (landmark.photoData) {
        const description = await analyzeLandmarkPhoto(landmark.photoData, landmark.name, landmark.type);
        if (description) {
          landmark.photoDescription = description;
        }
      }
    }));
    // Small delay between batches
    if (i + ANALYZE_BATCH_SIZE < validLandmarks.length) {
      await new Promise(resolve => setTimeout(resolve, ANALYZE_BATCH_DELAY_MS));
    }
  }

  const analyzedCount = validLandmarks.filter(l => l.photoDescription).length;
  log.info(`[LANDMARK] 🔍 Photo analysis: ${analyzedCount}/${validLandmarks.length} descriptions generated`);

  const elapsed = Date.now() - startTime;
  log.info(`[LANDMARK] ✅ Discovered ${validLandmarks.length} landmarks for "${location}" in ${elapsed}ms`);
  log.info(`[LANDMARK] 📊 Stats: ${landmarks.length} from Wikipedia → ${withPhotos.length} with photos → ${validLandmarks.length} returned (${analyzedCount} analyzed)`);

  // Log the final landmarks
  if (validLandmarks.length > 0) {
    log.debug(`[LANDMARK] Final landmarks: ${validLandmarks.map(l => {
      const boostLabel = l.boostAmount === 100 ? '🏆' : (l.boostAmount === 50 ? '⭐' : '');
      return `${l.name} [${l.type || '?'}]${boostLabel} score=${l.score}`;
    }).join(', ')}`);
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
