/**
 * Landmark Photo Service
 *
 * Fetches reference photos for real-world landmarks from Wikimedia Commons / Openverse
 * to improve image generation accuracy for famous buildings, monuments, etc.
 */

const { log } = require('../utils/logger');
const { compressImageToJPEG } = require('./images');
const { getPool } = require('../services/database');
const { callAnthropicAPI } = require('./textModels');
const { TEXT_MODELS } = require('../config/models');

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
  { pattern: /\blake\b|see$|\blac\b/i, type: 'Lake' },
  { pattern: /river|fluss|rivière/i, type: 'River' },
  { pattern: /\bmountain\b|berg$|\bmont\b|\bmontagne\b/i, type: 'Mountain' },
  { pattern: /cave|höhle|grotte/i, type: 'Cave' },
  { pattern: /waterfall|wasserfall|cascade/i, type: 'Waterfall' },
  // Generic fallbacks
  { pattern: /historic|historisch|historique/i, type: 'Historic site' },
  { pattern: /landmark|sehenswürdigkeit|monument/i, type: 'Landmark' },
  { pattern: /building|gebäude|bâtiment/i, type: 'Building' }
];

// ============================================================================
// AI-BASED DIVERSITY SELECTION (uses cheap Haiku model)
// ============================================================================

/**
 * Select the most diverse photos from a list using AI
 * Sends all descriptions in one call, asks AI to pick N diverse ones
 * @param {Array<{description: string, ...}>} images - Array of image objects with descriptions
 * @param {number} count - How many diverse images to select (default 3)
 * @returns {Promise<number[]>} - Indices of the most diverse images (0-based)
 */
async function selectDiversePhotosWithAI(images, count = 3) {
  // Filter to images with descriptions
  const withDescriptions = images
    .map((img, idx) => ({ idx, desc: img.description }))
    .filter(item => item.desc && item.desc.length >= 20);

  // If not enough images with descriptions, return first N indices
  if (withDescriptions.length <= count) {
    return withDescriptions.map(item => item.idx);
  }

  // Build numbered list of descriptions
  const descList = withDescriptions
    .map((item, i) => `${i + 1}. ${item.desc}`)
    .join('\n');

  const prompt = `Here are ${withDescriptions.length} photo descriptions of a landmark:

${descList}

Select the ${count} most DIVERSE photos - different angles, viewpoints, or features shown.
Reply with ONLY ${count} numbers separated by commas (e.g., "1,4,7"). Nothing else.`;

  try {
    const haikuModel = TEXT_MODELS['claude-haiku'];
    const result = await callAnthropicAPI(prompt, 20, haikuModel.modelId);
    const response = result.text.trim();

    // Parse comma-separated numbers
    const numbers = response.match(/\d+/g);
    if (!numbers || numbers.length === 0) {
      log.warn(`[AI-DIVERSITY] Could not parse response: "${response}"`);
      return withDescriptions.slice(0, count).map(item => item.idx);
    }

    // Convert 1-based AI response to 0-based indices, map back to original indices
    const selectedIndices = numbers
      .slice(0, count)
      .map(n => parseInt(n) - 1)
      .filter(i => i >= 0 && i < withDescriptions.length)
      .map(i => withDescriptions[i].idx);

    log.debug(`[AI-DIVERSITY] Selected ${selectedIndices.length} diverse photos: ${selectedIndices.join(', ')}`);
    return selectedIndices.length > 0 ? selectedIndices : withDescriptions.slice(0, count).map(item => item.idx);
  } catch (err) {
    log.warn(`[AI-DIVERSITY] AI selection failed, using first ${count}: ${err.message}`);
    return withDescriptions.slice(0, count).map(item => item.idx);
  }
}

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
  // Collect all matching types and prefer specific ones over generic (Building, Station)
  const GENERIC_TYPES = ['Building', 'Station', 'Landmark', 'Historic site'];
  let specificType = null;
  let genericType = null;

  for (const cat of categories) {
    for (const { pattern, type: matchType } of CATEGORY_TO_TYPE) {
      if (pattern.test(cat)) {
        if (GENERIC_TYPES.includes(matchType)) {
          // Store generic type but keep looking for specific
          if (!genericType) genericType = matchType;
        } else {
          // Found a specific type - use it
          specificType = matchType;
          break;
        }
      }
    }
    if (specificType) break;
  }

  const type = specificType || genericType;

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

  log.debug(`[LANDMARK-CAT] Enriching ${landmarks.length} landmarks (${skippedCount} skipped, no pageId/lang)`);

  // Track enrichment results for summary
  let typedCount = 0;
  let highBoostCount = 0;
  let medBoostCount = 0;
  let noCategoriesCount = 0;

  // Fetch categories per language in parallel
  await Promise.all(Array.from(byLang.entries()).map(async ([lang, langLandmarks]) => {
    const pageIds = langLandmarks.map(l => l.pageId);
    const categoryMap = await fetchWikipediaCategories(lang, pageIds);

    for (const landmark of langLandmarks) {
      const categories = categoryMap.get(landmark.pageId) || [];
      landmark.categories = categories;
      const { type, boostAmount } = parseLandmarkCategories(categories);
      landmark.type = type;
      landmark.boostAmount = boostAmount;

      // Track stats for summary
      if (categories.length === 0) {
        noCategoriesCount++;
      } else if (type) {
        typedCount++;
        if (boostAmount === 100) highBoostCount++;
        else if (boostAmount === 50) medBoostCount++;
      }
    }
  }));

  // Log summary instead of individual results
  log.info(`[LANDMARK-CAT] Enriched ${landmarks.length} landmarks: ${typedCount} typed, ${highBoostCount} high-boost, ${medBoostCount} med-boost, ${noCategoriesCount} no-categories`);
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
 * Fetch Wikipedia article extract (summary text)
 * @param {string} lang - Wikipedia language code (e.g., 'de', 'en')
 * @param {number} pageId - Wikipedia page ID
 * @param {number} maxSentences - Maximum sentences to return (default 3)
 * @returns {Promise<string|null>} - Article extract or null
 */
async function fetchWikipediaExtract(lang, pageId, maxSentences = 3) {
  if (!lang || !pageId) return null;

  try {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&pageids=${pageId}` +
      `&prop=extracts&exintro=1&explaintext=1&exsentences=${maxSentences}` +
      `&format=json&origin=*`;

    log.debug(`[WIKI] Fetching extract for ${lang}:${pageId}`);
    const res = await fetch(url, { headers: WIKI_HEADERS });
    const data = await res.json();

    const page = data.query?.pages?.[pageId];
    const extract = page?.extract?.trim();

    if (extract && extract.length > 20) {
      log.debug(`[WIKI] Got extract (${extract.length} chars): "${extract.substring(0, 80)}..."`);
      return extract;
    }
    return null;
  } catch (err) {
    log.debug(`[WIKI] Extract error: ${err.message}`);
    return null;
  }
}

/**
 * Get Commons category name from Wikidata QID
 * @param {string} qid - Wikidata QID (e.g., "Q1625435")
 * @returns {Promise<string|null>} - Commons category name or null
 */
async function getCommonsCategoryFromWikidata(qid) {
  if (!qid) return null;

  try {
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=claims&format=json&origin=*`;
    const res = await fetch(url, { headers: WIKI_HEADERS });
    const data = await res.json();

    // P373 is the "Commons category" property
    const p373 = data.entities?.[qid]?.claims?.P373?.[0]?.mainsnak?.datavalue?.value;
    if (p373) {
      log.debug(`[WIKI] Found Commons category for ${qid}: "${p373}"`);
      return p373;
    }
    return null;
  } catch (err) {
    log.debug(`[WIKI] Error getting Commons category: ${err.message}`);
    return null;
  }
}

/**
 * Fetch images from a Wikimedia Commons category
 * @param {string} categoryName - Category name (without "Category:" prefix)
 * @param {number} maxImages - Maximum images to return
 * @returns {Promise<Array<{url, fileName, attribution}>>}
 */
async function fetchImagesFromCommonsCategory(categoryName, maxImages = 10) {
  const images = [];

  try {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&list=categorymembers` +
      `&cmtitle=Category:${encodeURIComponent(categoryName)}` +
      `&cmtype=file&cmlimit=${maxImages * 2}&format=json&origin=*`;

    log.debug(`[COMMONS-CAT] Fetching images from category: "${categoryName}"`);
    const res = await fetch(url, { headers: WIKI_HEADERS });
    const data = await res.json();

    const files = data.query?.categorymembers || [];
    log.debug(`[COMMONS-CAT] Found ${files.length} files in category`);

    // Filter to photos and get URLs
    for (const file of files) {
      if (images.length >= maxImages) break;

      const name = file.title.toLowerCase();
      if (!name.endsWith('.jpg') && !name.endsWith('.jpeg') && !name.endsWith('.png')) continue;
      if (name.includes('logo') || name.includes('map') || name.includes('icon')) continue;

      // Get image info
      const infoUrl = `https://commons.wikimedia.org/w/api.php?action=query` +
        `&titles=${encodeURIComponent(file.title)}` +
        `&prop=imageinfo&iiprop=url|user|size&format=json&origin=*`;

      const infoRes = await fetch(infoUrl, { headers: WIKI_HEADERS });
      const infoData = await infoRes.json();
      const pages = infoData.query?.pages;
      const page = pages ? Object.values(pages)[0] : null;
      const info = page?.imageinfo?.[0];

      if (info?.url && info.width >= 400 && info.height >= 300) {
        images.push({
          url: info.url,
          fileName: file.title.replace('File:', ''),
          attribution: `Photo by ${info.user || 'Unknown'}, Wikimedia Commons`,
          width: info.width,
          height: info.height
        });
      }
    }

    log.debug(`[COMMONS-CAT] Retrieved ${images.length} valid images`);
    return images;
  } catch (err) {
    log.error(`[COMMONS-CAT] Error: ${err.message}`);
    return images;
  }
}

/**
 * Fetch ALL images from a Wikipedia article - these are guaranteed to be correct location
 * @param {string} lang - Wikipedia language code
 * @param {number} pageId - Wikipedia page ID
 * @param {number} maxImages - Maximum images to return
 * @returns {Promise<Array<{url, fileName, attribution}>>}
 */
async function fetchWikipediaArticleImages(lang, pageId, maxImages = 6) {
  const images = [];

  try {
    // Get list of images on the article
    const listUrl = `https://${lang}.wikipedia.org/w/api.php?` +
      `action=query&pageids=${pageId}` +
      `&prop=images&imlimit=${maxImages * 2}` +
      `&format=json&origin=*`;

    log.debug(`[WIKI-IMAGES] Fetching images from ${lang}:${pageId}`);
    const listRes = await fetch(listUrl, { headers: WIKI_HEADERS });
    const listData = await listRes.json();

    const page = listData.query?.pages?.[pageId];
    if (!page?.images?.length) {
      log.debug(`[WIKI-IMAGES] No images found in article ${lang}:${pageId}`);
      return images;
    }

    // Filter to actual photos (not icons, maps, flags, etc.)
    const photoFiles = page.images.filter(img => {
      const name = img.title.toLowerCase();
      return (name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png')) &&
        !name.includes('icon') && !name.includes('logo') && !name.includes('flag') &&
        !name.includes('wappen') && !name.includes('coat') && !name.includes('map') &&
        !name.includes('karte') && !name.includes('plan') && !name.includes('commons-logo') &&
        !name.includes('edit-clear') && !name.includes('symbol');
    });

    log.debug(`[WIKI-IMAGES] Found ${photoFiles.length} potential photos (from ${page.images.length} total)`);

    // Get URLs for each image
    for (const img of photoFiles.slice(0, maxImages)) {
      try {
        // Normalize title: German Wikipedia uses "Datei:", French uses "Fichier:", etc.
        // Commons always uses "File:"
        const commonsTitle = img.title
          .replace(/^Datei:/i, 'File:')
          .replace(/^Fichier:/i, 'File:')
          .replace(/^Archivo:/i, 'File:')
          .replace(/^Immagine:/i, 'File:');

        const infoUrl = `https://commons.wikimedia.org/w/api.php?` +
          `action=query&titles=${encodeURIComponent(commonsTitle)}` +
          `&prop=imageinfo&iiprop=url|user|size` +
          `&format=json&origin=*`;

        const infoRes = await fetch(infoUrl, { headers: WIKI_HEADERS });
        const infoData = await infoRes.json();

        const pages = infoData.query?.pages;
        const infoPage = pages ? Object.values(pages)[0] : null;
        const info = infoPage?.imageinfo?.[0];

        if (info?.url && info.width >= 400 && info.height >= 300) {
          images.push({
            url: info.url,
            fileName: commonsTitle.replace('File:', ''),
            attribution: `Photo by ${info.user || 'Unknown'}, Wikimedia Commons`,
            width: info.width,
            height: info.height
          });
        }
      } catch (err) {
        log.debug(`[WIKI-IMAGES] Error getting info for ${img.title}: ${err.message}`);
      }
    }

    log.debug(`[WIKI-IMAGES] Retrieved ${images.length} valid images for ${lang}:${pageId}`);
    return images;

  } catch (err) {
    log.error(`[WIKI-IMAGES] Error fetching article images:`, err.message);
    return images;
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

// ============================================================================
// MULTI-IMAGE QUALITY ANALYSIS
// ============================================================================

/**
 * Fetch multiple images from Wikimedia Commons for a landmark
 * @param {string} landmarkName - Name of landmark to search for
 * @param {number} maxImages - Maximum images to fetch (default 4)
 * @returns {Promise<Array<{url, fileName, attribution, width, height}>>}
 */
async function fetchMultipleImages(landmarkName, maxImages = 4, locationContext = null) {
  const images = [];

  try {
    // Build search query with location context to avoid wrong matches
    // e.g., "Ruine Stein" alone might find Austrian castle, but "Ruine Stein Baden Switzerland" finds the right one
    let searchQuery = landmarkName;
    if (locationContext) {
      searchQuery = `${landmarkName} ${locationContext}`;
    }

    // Search Wikimedia Commons for images
    const searchUrl = `https://commons.wikimedia.org/w/api.php?action=query&list=search` +
      `&srsearch=${encodeURIComponent(searchQuery + ' filetype:jpg|jpeg|png')}` +
      `&srnamespace=6&srlimit=${maxImages * 2}&format=json&origin=*`;

    const searchRes = await fetch(searchUrl, { headers: WIKI_HEADERS });
    const searchData = await searchRes.json();

    if (!searchData.query?.search?.length) {
      log.debug(`[MULTI-IMG] No images found for "${landmarkName}"`);
      return images;
    }

    // Get details for each image
    for (const result of searchData.query.search) {
      if (images.length >= maxImages) break;

      const fileName = result.title;
      const lowerName = fileName.toLowerCase();

      // Skip non-photos
      if (lowerName.endsWith('.svg') || lowerName.endsWith('.pdf') ||
          lowerName.endsWith('.webm') || lowerName.endsWith('.ogv') ||
          lowerName.includes('map') || lowerName.includes('logo') ||
          lowerName.includes('wappen') || lowerName.includes('flag') ||
          lowerName.includes('coat of arms') || lowerName.includes('plan')) {
        continue;
      }

      // Get image info
      const infoUrl = `https://commons.wikimedia.org/w/api.php?action=query` +
        `&titles=${encodeURIComponent(fileName)}` +
        `&prop=imageinfo&iiprop=url|user|size|mime&format=json&origin=*`;

      const infoRes = await fetch(infoUrl, { headers: WIKI_HEADERS });
      const infoData = await infoRes.json();

      const pages = infoData.query?.pages;
      const page = pages ? Object.values(pages)[0] : null;
      const info = page?.imageinfo?.[0];

      if (!info?.url || !info.mime?.startsWith('image/')) continue;

      // Skip tiny images
      if (info.width < 400 || info.height < 300) {
        log.debug(`[MULTI-IMG] Skipping small image: ${info.width}x${info.height}`);
        continue;
      }

      images.push({
        url: info.url,
        fileName: fileName.replace('File:', ''),
        attribution: `Photo by ${info.user || 'Unknown'}, Wikimedia Commons`,
        width: info.width,
        height: info.height
      });
    }

    log.debug(`[MULTI-IMG] Found ${images.length} images for "${landmarkName}"`);
    return images;

  } catch (err) {
    log.error(`[MULTI-IMG] Error fetching images for "${landmarkName}": ${err.message}`);
    return images;
  }
}

/**
 * Analyze an image for quality, suitability, and location verification
 * @param {string} imageUrl - URL of image to analyze
 * @param {string} landmarkName - Name of the landmark
 * @param {string} expectedLocation - Expected location (e.g., "Baden, Switzerland")
 * @returns {Promise<{score, isPhoto, isExterior, locationMatch, description, issues}|null>}
 */
async function analyzeImageQuality(imageUrl, landmarkName, expectedLocation = null) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    // Download image
    const imgRes = await fetch(imageUrl, {
      headers: { 'User-Agent': 'MagicalStory/1.0 (https://magicalstory.ch)' },
      signal: AbortSignal.timeout(10000)
    });

    if (!imgRes.ok) return null;

    const buffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const mimeType = contentType.split(';')[0].trim();

    // Analyze with Gemini - include location verification
    const locationCheck = expectedLocation
      ? `\n5. LOCATION_MATCH: Does this appear to be "${landmarkName}" in ${expectedLocation}? (10 = definitely matches, 1 = clearly shows a different place/country)`
      : '';

    const locationField = expectedLocation
      ? `\n  "locationMatch": <1-10>,\n  "detectedLocation": "where this photo appears to be taken",`
      : '';

    const prompt = `Analyze this image of "${landmarkName}"${expectedLocation ? ` (expected location: ${expectedLocation})` : ''} for use as a reference in children's book illustration.

Rate each criterion 1-10:
1. PHOTO_QUALITY: Is it a clear, well-lit photograph? (not blurry, not too dark)
2. IS_LANDMARK_PHOTO: Does it show a building, monument, or natural landmark? (not a map, diagram, logo, portrait, text, information sign, plaque, or commemorative board)
3. VISUAL_INTEREST: Would it be interesting/recognizable in a children's book?
4. COMPOSITION: Is the main subject clearly visible and well-framed?${locationCheck}

Respond in this exact JSON format:
{
  "photoQuality": <1-10>,
  "isLandmarkPhoto": <1-10>,
  "visualInterest": <1-10>,
  "composition": <1-10>,${locationField}
  "isExterior": <true/false>,
  "isActualPhoto": <true/false>,
  "issues": ["list any problems"],
  "description": "One sentence describing what's in the photo"
}

IMPORTANT for isActualPhoto: Set to FALSE if this is a painting, drawing, illustration, engraving, historical artwork, or any non-photographic image. Only set TRUE for actual photographs.`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inlineData: { mimeType, data: base64 } }
          ]
        }],
        generationConfig: {
          maxOutputTokens: 300,
          temperature: 0.1
        }
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      log.debug(`[IMG-QUALITY] Gemini error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!text) return null;

    // Parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.debug(`[IMG-QUALITY] Could not parse JSON from: ${text.substring(0, 100)}`);
      return null;
    }

    const analysis = JSON.parse(jsonMatch[0]);

    // Calculate overall score (weighted average)
    // If location verification is enabled and fails, heavily penalize
    const locationMatch = analysis.locationMatch || 10;  // Default to 10 if not checked
    const locationPenalty = locationMatch < 5 ? 0.3 : 1.0;  // 70% penalty if wrong location

    const baseScore = (
      (analysis.photoQuality * 0.2) +
      (analysis.isLandmarkPhoto * 0.35) +
      (analysis.visualInterest * 0.25) +
      (analysis.composition * 0.2)
    );

    const score = Math.round(baseScore * locationPenalty);

    // Log location mismatch warnings
    if (locationMatch < 5) {
      log.warn(`[IMG-QUALITY] Location mismatch for "${landmarkName}": detected "${analysis.detectedLocation || 'unknown'}" (score: ${locationMatch}/10)`);
    }

    return {
      score,
      isPhoto: analysis.isLandmarkPhoto >= 5,
      isExterior: analysis.isExterior,
      isActualPhoto: analysis.isActualPhoto !== false,  // Default to true if not specified
      locationMatch,
      detectedLocation: analysis.detectedLocation,
      description: analysis.description,
      issues: analysis.issues || [],
      raw: analysis
    };

  } catch (err) {
    log.debug(`[IMG-QUALITY] Error analyzing ${imageUrl.substring(0, 50)}: ${err.message}`);
    return null;
  }
}

/**
 * Find best images for a landmark - returns up to 2 exterior + 2 interior photos
 * Strategy:
 * 1. Try Commons category (via Wikidata QID) - many images, guaranteed correct
 * 2. If not enough, try Wikipedia article images
 * 3. If still not enough, fallback to Commons search with canton+Switzerland
 *
 * @param {string} landmarkName - Name of landmark
 * @param {string} landmarkType - Type of landmark (Castle, Church, etc.)
 * @param {string} lang - Wikipedia language code
 * @param {number} pageId - Wikipedia page ID (for article images)
 * @param {string} qid - Wikidata QID (for Commons category lookup)
 * @param {string} region - Region code (e.g., "AG" for Swiss canton, "Bavaria" for German state)
 * @param {string} country - Country name (e.g., "Switzerland", "Germany")
 * @returns {Promise<{exteriorImages: Array, interiorImages: Array, source: string}|null>}
 */
async function findBestLandmarkImage(landmarkName, landmarkType, lang = null, pageId = null, qid = null, region = null, country = 'Switzerland') {
  log.info(`[BEST-IMG] Finding images for "${landmarkName}" (${landmarkType || 'unknown'})`);

  let candidates = [];
  let allGoodImages = [];

  // STEP 1: Try Commons category via Wikidata (best source - many correct images)
  if (qid) {
    const commonsCategory = await getCommonsCategoryFromWikidata(qid);
    if (commonsCategory) {
      log.debug(`[BEST-IMG] Trying Commons category: "${commonsCategory}"`);
      candidates = await fetchImagesFromCommonsCategory(commonsCategory, 20);  // Get more to find 3 exterior + 3 interior with diversity

      if (candidates.length > 0) {
        allGoodImages = await analyzeAndFilterImages(candidates, landmarkName, null);
        log.debug(`[BEST-IMG] Commons category: ${allGoodImages.length} good images`);
      }
    }
  }

  // STEP 2: Try Wikipedia article images (if we need more variety)
  if (allGoodImages.length < 6 && lang && pageId) {
    log.debug(`[BEST-IMG] Trying Wikipedia article (${lang}:${pageId})...`);
    candidates = await fetchWikipediaArticleImages(lang, pageId, 12);  // More candidates for diversity

    if (candidates.length > 0) {
      const articleImages = await analyzeAndFilterImages(candidates, landmarkName, null);
      for (const img of articleImages) {
        if (!allGoodImages.some(g => g.url === img.url)) {
          allGoodImages.push(img);
        }
      }
    }
  }

  // STEP 3: Fallback to Commons search with location (if we have very few)
  if (allGoodImages.length < 2) {
    log.debug(`[BEST-IMG] Trying Commons search with location...`);

    const locationSuffix = region ? `${region} ${country}` : country;
    const searchQuery = `${landmarkName} ${locationSuffix}`;
    candidates = await fetchMultipleImages(searchQuery, 8, null);

    if (candidates.length > 0) {
      const locationContext = region ? `${region}, ${country}` : country;
      const searchImages = await analyzeAndFilterImages(candidates, landmarkName, locationContext);

      for (const img of searchImages) {
        if (!allGoodImages.some(g => g.url === img.url)) {
          allGoodImages.push(img);
        }
      }
    }
  }

  if (allGoodImages.length === 0) {
    log.warn(`[BEST-IMG] No good images found for "${landmarkName}" from any source`);
    return null;
  }

  // Helper function to filter for diversity (avoid duplicate/similar photos)
  // Step 1: Remove URL duplicates (fast, free)
  // Step 2: Use AI to select most diverse from remaining (one API call)
  async function selectDiverseImages(images, maxCount) {
    if (images.length <= maxCount) return images;

    // Sort by score first
    const sorted = [...images].sort((a, b) => b.score - a.score);

    // Step 1: Remove URL duplicates (keep first occurrence = highest score)
    const usedUrls = new Set();
    const deduped = [];
    for (const img of sorted) {
      const baseUrl = img.url.split('/').pop().split('?')[0].toLowerCase();
      const isDuplicate = usedUrls.has(baseUrl) ||
        Array.from(usedUrls).some(url => url.includes(baseUrl.slice(0, 20)) || baseUrl.includes(url.slice(0, 20)));

      if (!isDuplicate) {
        deduped.push(img);
        usedUrls.add(baseUrl);
      } else {
        log.debug(`[BEST-IMG] Skipping URL duplicate: ${baseUrl}`);
      }
    }

    if (deduped.length <= maxCount) return deduped;

    // Step 2: Use AI to select most diverse photos (one call)
    // Take top 10 candidates (by score) for AI to choose from
    const candidates = deduped.slice(0, 10);
    const selectedIndices = await selectDiversePhotosWithAI(candidates, maxCount);

    // Map indices back to images
    const selected = selectedIndices.map(i => candidates[i]).filter(Boolean);

    // If AI didn't return enough, fill with top-scored remaining
    if (selected.length < maxCount) {
      for (const img of candidates) {
        if (selected.length >= maxCount) break;
        if (!selected.includes(img)) {
          selected.push(img);
        }
      }
    }

    return selected;
  }

  // Separate exterior and interior images, sort by score, ensure diversity
  const exteriorCandidates = allGoodImages
    .filter(img => img.isExterior !== false)  // Include if exterior or unknown
    .sort((a, b) => b.score - a.score);

  // Exclude information signs, plaques, maps from interior candidates
  const isInformationSign = (desc) => /\b(sign|plaque|board|map|diagram|information|commemorat)/i.test(desc || '');

  const interiorCandidates = allGoodImages
    .filter(img => img.isExterior === false && img.isActualPhoto !== false && !isInformationSign(img.description))
    .sort((a, b) => b.score - a.score);

  // Select up to 3 diverse images for each type (async for AI checks)
  const exteriorImages = await selectDiverseImages(exteriorCandidates, 3);
  const interiorImages = await selectDiverseImages(interiorCandidates, 3);

  log.info(`[BEST-IMG] ✅ "${landmarkName}": ${exteriorImages.length} exterior + ${interiorImages.length} interior (from ${exteriorCandidates.length}/${interiorCandidates.length} candidates)`);

  return { exteriorImages, interiorImages, source: 'combined' };
}

/**
 * Analyze images and filter to good quality ones
 * @param {Array} candidates - Array of image candidates
 * @param {string} landmarkName - Name of landmark
 * @param {string} locationContext - Expected location (null to skip location check)
 * @returns {Promise<Array>} - Filtered and sorted good images
 */
async function analyzeAndFilterImages(candidates, landmarkName, locationContext) {
  const analyzed = [];

  for (const img of candidates) {
    const analysis = await analyzeImageQuality(img.url, landmarkName, locationContext);
    if (analysis) {
      analyzed.push({ ...img, ...analysis });
    }
    await new Promise(r => setTimeout(r, 200));  // Rate limiting
  }

  // Sort by score (highest first)
  analyzed.sort((a, b) => b.score - a.score);

  // Filter to valid images (score >= 5, is a landmark photo, correct location if checked)
  const minLocationScore = locationContext ? 5 : 0;
  const goodImages = analyzed.filter(img =>
    img.score >= 5 &&
    img.isPhoto &&
    (img.locationMatch || 10) >= minLocationScore
  );

  return goodImages;
}

/**
 * Pre-fetch photos for all landmarks in a Visual Bible
 * Designed to run in background as soon as landmarks are detected
 * Handles both regular discovery and Swiss pre-indexed landmarks (lazy loading)
 * @param {Object} visualBible - Parsed Visual Bible object
 * @returns {Promise<Object>} Updated Visual Bible with photo data
 */
async function prefetchLandmarkPhotos(visualBible) {
  if (!visualBible?.locations) {
    return visualBible;
  }

  // Find locations marked as real landmarks that don't already have photos
  // (Skip landmarks that were already linked from pre-discovered cache with photoData)
  const landmarks = visualBible.locations.filter(
    loc => loc.isRealLandmark && loc.landmarkQuery && loc.photoFetchStatus !== 'success'
  );

  if (landmarks.length === 0) {
    log.debug(`[LANDMARK] No landmarks need photo fetching (all already linked or none found)`);
    return visualBible;
  }

  // Separate Swiss pre-indexed landmarks (have photoUrl, need lazy load) from regular landmarks
  const swissLandmarks = landmarks.filter(loc => loc.photoFetchStatus === 'pending_lazy' && loc.isSwissPreIndexed);
  const regularLandmarks = landmarks.filter(loc => loc.photoFetchStatus !== 'pending_lazy');

  log.info(`[LANDMARK] 🌍 Pre-fetching photos: ${swissLandmarks.length} Swiss (lazy), ${regularLandmarks.length} regular`);
  const startTime = Date.now();

  // Fetch Swiss landmarks using lazy loading (from stored URL)
  const swissResults = await Promise.allSettled(swissLandmarks.map(async (loc) => {
    try {
      // Use the landmark object directly for lazy loading
      const photo = await getLandmarkPhotoOnDemand({
        id: loc.swissLandmarkId,
        name: loc.landmarkQuery,
        photo_url: loc.referencePhotoUrl
      });

      if (photo) {
        loc.referencePhotoData = photo.photoData;
        loc.photoFetchStatus = 'success';
        return { name: loc.name, success: true, type: 'swiss' };
      } else {
        loc.photoFetchStatus = 'failed';
        return { name: loc.name, success: false, type: 'swiss' };
      }
    } catch (err) {
      loc.photoFetchStatus = 'failed';
      log.error(`[LANDMARK] Error lazy-loading Swiss photo for "${loc.name}":`, err.message);
      return { name: loc.name, success: false, error: err.message, type: 'swiss' };
    }
  }));

  // Fetch regular landmarks using full discovery
  const regularResults = await Promise.allSettled(regularLandmarks.map(async (loc) => {
    try {
      const photo = await fetchLandmarkPhoto(loc.landmarkQuery);

      if (photo) {
        loc.referencePhotoUrl = photo.photoUrl;
        loc.referencePhotoData = photo.photoData;
        loc.photoAttribution = photo.attribution;
        loc.photoSource = photo.source;
        loc.photoFetchStatus = 'success';
        return { name: loc.name, success: true, type: 'regular' };
      } else {
        loc.photoFetchStatus = 'failed';
        return { name: loc.name, success: false, type: 'regular' };
      }
    } catch (err) {
      loc.photoFetchStatus = 'failed';
      log.error(`[LANDMARK] Error fetching photo for "${loc.name}":`, err.message);
      return { name: loc.name, success: false, error: err.message, type: 'regular' };
    }
  }));

  const allResults = [...swissResults, ...regularResults];
  const elapsed = Date.now() - startTime;
  const successCount = allResults.filter(r => r.status === 'fulfilled' && r.value?.success).length;
  const swissSuccess = swissResults.filter(r => r.status === 'fulfilled' && r.value?.success).length;

  log.info(`[LANDMARK] ✅ Pre-fetch complete: ${successCount}/${landmarks.length} photos (${swissSuccess} Swiss lazy-loaded) in ${elapsed}ms`);

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
      let skippedCount = 0;  // Track filtered candidates for summary log
      const totalItems = data.query?.geosearch?.length || 0;

      for (const item of data.query?.geosearch || []) {
        const name = item.title;

        // Skip if matches exclude pattern
        if (excludeRegex && excludeRegex.test(name)) {
          skippedCount++;
          continue;
        }

        // Skip generic Wikipedia articles
        if (/^(List of|Category:|Template:|Wikipedia:|Liste |Kategorie:)/i.test(name)) {
          skippedCount++;
          continue;
        }

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
          skippedCount++;
          continue;
        }

        // Skip Swiss city articles (e.g., "Baden AG", "Zürich ZH")
        if (/^[A-ZÄÖÜ][a-zäöü]+\s+(AG|ZH|BE|LU|SG|BL|BS|SO|TG|GR|VS|NE|GE|VD|TI|FR|JU|SH|AR|AI|OW|NW|GL|ZG|SZ|UR)$/i.test(name)) {
          skippedCount++;
          continue;
        }

        // Skip entries that are just city/municipality names (end with ", Country/Region")
        // BUT keep them if they have landmark indicators (e.g., "Stein Castle, Aargau")
        if (!hasLandmarkIndicator && /,\s*(Switzerland|Germany|Austria|France|Italy|Aargau|Canton|Zurich|Bern|Basel|Schweiz|Deutschland|Österreich|Frankreich|Italien)$/i.test(name)) {
          skippedCount++;
          continue;
        }

        // Skip pure municipality names - short names without descriptive words
        const wordCount = name.split(/[\s\-]+/).length;
        if (wordCount <= 2 && !hasLandmarkIndicator) {
          skippedCount++;
          continue;
        }

        // Skip single-word names that look like place names (capitalized, no indicator)
        if (wordCount === 1 && /^[A-ZÄÖÜ][a-zäöüß]+$/.test(name) && !hasLandmarkIndicator) {
          skippedCount++;
          continue;
        }

        langCandidates.push({
          name,
          query: name,
          source: `wikipedia-${lang}`,
          distance: item.dist,
          lat: item.lat,    // Capture coordinates from geosearch
          lon: item.lon,
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

      log.debug(`[LANDMARK] Wikipedia (${lang}): ${langCandidates.length} candidates from ${totalItems} results (filtered ${skippedCount} non-landmarks)`);
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

  // Step 8: Fetch Wikipedia extracts (what the landmark IS, for outline prompt)
  log.info(`[LANDMARK] 📚 Fetching Wikipedia extracts for ${validLandmarks.length} landmarks...`);
  const EXTRACT_BATCH_SIZE = 10;
  const EXTRACT_BATCH_DELAY_MS = 50;

  for (let i = 0; i < validLandmarks.length; i += EXTRACT_BATCH_SIZE) {
    const batch = validLandmarks.slice(i, i + EXTRACT_BATCH_SIZE);
    await Promise.allSettled(batch.map(async (landmark) => {
      if (landmark.pageId && landmark.lang) {
        const extract = await fetchWikipediaExtract(landmark.lang, landmark.pageId, 3);
        if (extract) {
          landmark.wikipediaExtract = extract;
        }
      }
    }));
    // Small delay between batches
    if (i + EXTRACT_BATCH_SIZE < validLandmarks.length) {
      await new Promise(resolve => setTimeout(resolve, EXTRACT_BATCH_DELAY_MS));
    }
  }

  const extractCount = validLandmarks.filter(l => l.wikipediaExtract).length;
  log.info(`[LANDMARK] 📚 Wikipedia extracts: ${extractCount}/${validLandmarks.length} fetched`);

  const elapsed = Date.now() - startTime;
  log.info(`[LANDMARK] ✅ Discovered ${validLandmarks.length} landmarks for "${location}" in ${elapsed}ms`);
  log.info(`[LANDMARK] 📊 Stats: ${landmarks.length} from Wikipedia → ${withPhotos.length} with photos → ${validLandmarks.length} returned (${analyzedCount} analyzed)`);

  // Log the final landmarks
  if (validLandmarks.length > 0) {
    log.debug(`[LANDMARK] Final landmarks: ${validLandmarks.map(l => {
      const boostLabel = l.boostAmount === 100 ? '🏆' : (l.boostAmount === 50 ? '⭐' : '');
      return `${l.name} [${l.type || '?'}]${boostLabel} score=${l.score}`;
    }).join(', ')}`);

    // Run FULL indexing in background (multi-photo with AI diversity selection)
    // This is identical to running /api/admin/landmark-index/index-city
    log.info(`[LANDMARK] 💾 Running full indexing for "${city}, ${country}" in background...`);

    // Run in background - don't await
    indexLandmarksForCity(city, country, {
      analyzePhotos: true,           // AI-analyze photos for descriptions
      useMultiImageAnalysis: true,   // Use multi-image quality analysis
      maxLandmarks: 30               // Index top 30 landmarks
    }).then(result => {
      log.info(`[LANDMARK] 💾 Full indexing complete for "${city}": ${result.totalSaved} landmarks saved with ${result.totalAnalyzed || 0} photos analyzed`);
    }).catch(err => {
      log.error(`[LANDMARK] Full indexing error for "${city}":`, err);
    });
  }

  return validLandmarks;
}

// ============================================================================
// SWISS LANDMARKS - PRE-INDEXED LANDMARK DATABASE
// ============================================================================

/**
 * Get a landmark photo on-demand (lazy loading)
 * Used when a pre-indexed landmark is actually needed for story generation
 * @param {Object} landmark - Landmark object with name, photo_url, wikipedia_page_id, lang
 * @returns {Promise<{photoData: string, attribution: string}|null>}
 */
async function getLandmarkPhotoOnDemand(landmark) {
  if (!landmark?.name) return null;

  // Check in-memory cache first
  const cacheKey = landmark.wikidata_qid || landmark.id || `${landmark.lang}:${landmark.wikipedia_page_id}` || landmark.name;
  const cached = photoCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    log.debug(`[LANDMARK-LAZY] Cache hit for "${landmark.name}"`);
    return { photoData: cached.data, attribution: cached.attribution };
  }

  log.info(`[LANDMARK-LAZY] Fetching photo on-demand for "${landmark.name}"`);

  try {
    let photoData = null;

    // If we have a stored photo_url (Swiss pre-indexed), fetch directly from that URL
    if (landmark.photo_url) {
      log.debug(`[LANDMARK-LAZY] Using stored URL: ${landmark.photo_url.substring(0, 80)}...`);
      try {
        const response = await fetch(landmark.photo_url, {
          headers: WIKI_HEADERS,
          signal: AbortSignal.timeout(10000)
        });

        if (response.ok) {
          const buffer = await response.arrayBuffer();
          const base64 = Buffer.from(buffer).toString('base64');
          const contentType = response.headers.get('content-type') || 'image/jpeg';
          const mimeType = contentType.split(';')[0].trim();

          // Compress to JPEG if needed (keeping consistent with fetchLandmarkPhoto)
          // Parameters: (imageData, quality, maxDimension)
          photoData = await compressImageToJPEG(`data:${mimeType};base64,${base64}`, 85, 800);
          log.debug(`[LANDMARK-LAZY] Fetched from stored URL: ${Math.round(photoData.length / 1024)}KB`);
        }
      } catch (urlErr) {
        log.debug(`[LANDMARK-LAZY] Stored URL failed: ${urlErr.message}, falling back to search`);
      }
    }

    // Fall back to search-based fetch if URL didn't work
    if (!photoData) {
      const result = await fetchLandmarkPhoto(
        landmark.name,
        landmark.wikipedia_page_id,
        landmark.lang
      );
      if (result?.photoData) {
        photoData = result.photoData;
      }
    }

    if (photoData) {
      // Cache the result
      photoCache.set(cacheKey, {
        data: photoData,
        attribution: landmark.photo_attribution || 'Wikimedia Commons',
        timestamp: Date.now()
      });

      return {
        photoData: photoData,
        attribution: landmark.photo_attribution || 'Wikimedia Commons'
      };
    }

    return null;
  } catch (err) {
    log.warn(`[LANDMARK-LAZY] Failed to fetch "${landmark.name}": ${err.message}`);
    return null;
  }
}

/**
 * Get indexed landmarks near a location (works for any city worldwide)
 * @param {number} latitude
 * @param {number} longitude
 * @param {number} radiusKm - Search radius in kilometers (default 20km)
 * @param {number} limit - Maximum results (default 30)
 * @returns {Promise<Array>}
 */
async function getIndexedLandmarksNearLocation(latitude, longitude, radiusKm = 20, limit = 30) {
  const pool = getPool();
  if (!pool) {
    log.warn('[LANDMARK-INDEX] Database not available');
    return [];
  }

  try {
    // Use Haversine formula approximation for distance
    // 1 degree latitude ≈ 111km, 1 degree longitude ≈ 111km * cos(lat)
    const latDelta = radiusKm / 111;
    const lonDelta = radiusKm / (111 * Math.cos(latitude * Math.PI / 180));

    const result = await pool.query(`
      SELECT *,
        (6371 * acos(
          cos(radians($1)) * cos(radians(latitude)) *
          cos(radians(longitude) - radians($2)) +
          sin(radians($1)) * sin(radians(latitude))
        )) AS distance_km
      FROM landmark_index
      WHERE latitude BETWEEN $1 - $3 AND $1 + $3
        AND longitude BETWEEN $2 - $4 AND $2 + $4
      ORDER BY score DESC, distance_km ASC
      LIMIT $5
    `, [latitude, longitude, latDelta, lonDelta, limit]);

    log.info(`[LANDMARK-INDEX] Found ${result.rows.length} landmarks within ${radiusKm}km of (${latitude}, ${longitude})`);
    return result.rows;
  } catch (err) {
    log.error(`[LANDMARK-INDEX] Query error: ${err.message}`);
    return [];
  }
}

/**
 * Get indexed landmarks by city name (works for any city worldwide)
 * @param {string} city - City name
 * @param {number} limit - Maximum results (default 30)
 * @returns {Promise<Array>}
 */
async function getIndexedLandmarks(city, limit = 30) {
  const pool = getPool();
  if (!pool) {
    log.warn('[LANDMARK-INDEX] Database not available');
    return [];
  }

  try {
    const result = await pool.query(`
      SELECT * FROM landmark_index
      WHERE LOWER(nearest_city) = LOWER($1)
      ORDER BY score DESC
      LIMIT $2
    `, [city, limit]);

    log.info(`[LANDMARK-INDEX] Found ${result.rows.length} landmarks for city "${city}"`);
    return result.rows;
  } catch (err) {
    log.error(`[LANDMARK-INDEX] Query error: ${err.message}`);
    return [];
  }
}

/**
 * Get all indexed landmarks (for outline generation)
 * Returns top landmarks across all indexed cities
 * @param {number} limit - Maximum results (default 100)
 * @returns {Promise<Array>}
 */
async function getAllIndexedLandmarks(limit = 100) {
  const pool = getPool();
  if (!pool) {
    log.warn('[LANDMARK-INDEX] Database not available');
    return [];
  }

  try {
    const result = await pool.query(`
      SELECT * FROM landmark_index
      ORDER BY score DESC
      LIMIT $1
    `, [limit]);

    log.info(`[LANDMARK-INDEX] Retrieved ${result.rows.length} top landmarks from index`);
    return result.rows;
  } catch (err) {
    log.error(`[LANDMARK-INDEX] Query error: ${err.message}`);
    return [];
  }
}

/**
 * Save a landmark to the landmark_index table (works for any city worldwide)
 * @param {Object} landmark - Landmark data
 * @returns {Promise<boolean>} - Success status
 */
async function saveLandmarkToIndex(landmark) {
  const pool = getPool();
  if (!pool) return false;

  // Normalize values - ensure we don't save "undefined" strings
  const normalize = (val) => (val === undefined || val === 'undefined' || val === '') ? null : val;

  try {
    await pool.query(`
      INSERT INTO landmark_index (
        name, wikipedia_page_id, wikidata_qid, lang,
        latitude, longitude, nearest_city, country, region,
        type, boost_amount, categories,
        photo_url, photo_attribution, photo_source, photo_description,
        photo_url_2, photo_attribution_2, photo_description_2,
        photo_url_3, photo_attribution_3, photo_description_3,
        photo_url_4, photo_attribution_4, photo_description_4,
        photo_url_5, photo_attribution_5, photo_description_5,
        photo_url_6, photo_attribution_6, photo_description_6,
        wikipedia_extract,
        commons_photo_count, score
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34)
      ON CONFLICT (wikidata_qid) DO UPDATE SET
        name = EXCLUDED.name,
        latitude = COALESCE(EXCLUDED.latitude, landmark_index.latitude),
        longitude = COALESCE(EXCLUDED.longitude, landmark_index.longitude),
        country = COALESCE(EXCLUDED.country, landmark_index.country),
        region = COALESCE(EXCLUDED.region, landmark_index.region),
        type = COALESCE(EXCLUDED.type, landmark_index.type),
        photo_url = COALESCE(EXCLUDED.photo_url, landmark_index.photo_url),
        photo_attribution = COALESCE(EXCLUDED.photo_attribution, landmark_index.photo_attribution),
        photo_description = COALESCE(EXCLUDED.photo_description, landmark_index.photo_description),
        photo_url_2 = COALESCE(EXCLUDED.photo_url_2, landmark_index.photo_url_2),
        photo_attribution_2 = COALESCE(EXCLUDED.photo_attribution_2, landmark_index.photo_attribution_2),
        photo_description_2 = COALESCE(EXCLUDED.photo_description_2, landmark_index.photo_description_2),
        photo_url_3 = COALESCE(EXCLUDED.photo_url_3, landmark_index.photo_url_3),
        photo_attribution_3 = COALESCE(EXCLUDED.photo_attribution_3, landmark_index.photo_attribution_3),
        photo_description_3 = COALESCE(EXCLUDED.photo_description_3, landmark_index.photo_description_3),
        photo_url_4 = COALESCE(EXCLUDED.photo_url_4, landmark_index.photo_url_4),
        photo_attribution_4 = COALESCE(EXCLUDED.photo_attribution_4, landmark_index.photo_attribution_4),
        photo_description_4 = COALESCE(EXCLUDED.photo_description_4, landmark_index.photo_description_4),
        photo_url_5 = COALESCE(EXCLUDED.photo_url_5, landmark_index.photo_url_5),
        photo_attribution_5 = COALESCE(EXCLUDED.photo_attribution_5, landmark_index.photo_attribution_5),
        photo_description_5 = COALESCE(EXCLUDED.photo_description_5, landmark_index.photo_description_5),
        photo_url_6 = COALESCE(EXCLUDED.photo_url_6, landmark_index.photo_url_6),
        photo_attribution_6 = COALESCE(EXCLUDED.photo_attribution_6, landmark_index.photo_attribution_6),
        photo_description_6 = COALESCE(EXCLUDED.photo_description_6, landmark_index.photo_description_6),
        wikipedia_extract = COALESCE(EXCLUDED.wikipedia_extract, landmark_index.wikipedia_extract),
        score = EXCLUDED.score,
        updated_at = CURRENT_TIMESTAMP
    `, [
      landmark.name,
      landmark.pageId || landmark.wikipedia_page_id || null,
      landmark.qid || landmark.wikidata_qid,
      landmark.lang || null,
      landmark.lat || landmark.latitude || null,
      landmark.lon || landmark.longitude || null,
      landmark.nearestCity || landmark.nearest_city || null,
      landmark.country || null,
      landmark.region || landmark.canton || null,  // Support both new and old field names
      normalize(landmark.type),
      landmark.boostAmount || landmark.boost_amount || 0,
      landmark.categories || [],
      normalize(landmark.photoUrl || landmark.photo_url),
      normalize(landmark.attribution || landmark.photo_attribution),
      normalize(landmark.source || landmark.photo_source) || 'wikimedia',
      normalize(landmark.photoDescription || landmark.photo_description),
      normalize(landmark.photoUrl2 || landmark.photo_url_2),
      normalize(landmark.attribution2 || landmark.photo_attribution_2),
      normalize(landmark.photoDescription2 || landmark.photo_description_2),
      normalize(landmark.photoUrl3 || landmark.photo_url_3),
      normalize(landmark.attribution3 || landmark.photo_attribution_3),
      normalize(landmark.photoDescription3 || landmark.photo_description_3),
      normalize(landmark.photoUrl4 || landmark.photo_url_4),
      normalize(landmark.attribution4 || landmark.photo_attribution_4),
      normalize(landmark.photoDescription4 || landmark.photo_description_4),
      normalize(landmark.photoUrl5 || landmark.photo_url_5),
      normalize(landmark.attribution5 || landmark.photo_attribution_5),
      normalize(landmark.photoDescription5 || landmark.photo_description_5),
      normalize(landmark.photoUrl6 || landmark.photo_url_6),
      normalize(landmark.attribution6 || landmark.photo_attribution_6),
      normalize(landmark.photoDescription6 || landmark.photo_description_6),
      normalize(landmark.wikipediaExtract || landmark.wikipedia_extract),
      landmark.commonsPhotoCount || landmark.commons_photo_count || 0,
      landmark.score || 0
    ]);

    return true;
  } catch (err) {
    log.error(`[LANDMARK-INDEX] Save error for "${landmark.name}": ${err.message}`);
    return false;
  }
}

/**
 * Pre-configured Swiss cities for bulk indexing
 * Each entry has city, country, and region (canton)
 * These can be indexed via admin panel for fast landmark lookup
 */
const SWISS_CITIES = [
  // Major cities
  { city: 'Zürich', country: 'Switzerland', region: 'ZH' },
  { city: 'Genf', country: 'Switzerland', region: 'GE' },
  { city: 'Basel', country: 'Switzerland', region: 'BS' },
  { city: 'Lausanne', country: 'Switzerland', region: 'VD' },
  { city: 'Bern', country: 'Switzerland', region: 'BE' },
  { city: 'Winterthur', country: 'Switzerland', region: 'ZH' },
  { city: 'Luzern', country: 'Switzerland', region: 'LU' },
  { city: 'St. Gallen', country: 'Switzerland', region: 'SG' },
  { city: 'Lugano', country: 'Switzerland', region: 'TI' },
  { city: 'Biel', country: 'Switzerland', region: 'BE' },
  // Medium cities
  { city: 'Thun', country: 'Switzerland', region: 'BE' },
  { city: 'Fribourg', country: 'Switzerland', region: 'FR' },
  { city: 'Schaffhausen', country: 'Switzerland', region: 'SH' },
  { city: 'Chur', country: 'Switzerland', region: 'GR' },
  { city: 'Neuchâtel', country: 'Switzerland', region: 'NE' },
  { city: 'Sion', country: 'Switzerland', region: 'VS' },
  { city: 'Aarau', country: 'Switzerland', region: 'AG' },
  { city: 'Baden', country: 'Switzerland', region: 'AG' },
  { city: 'Zug', country: 'Switzerland', region: 'ZG' },
  { city: 'Solothurn', country: 'Switzerland', region: 'SO' },
  { city: 'Olten', country: 'Switzerland', region: 'SO' },
  { city: 'Bellinzona', country: 'Switzerland', region: 'TI' },
  { city: 'Locarno', country: 'Switzerland', region: 'TI' },
  // Smaller but landmark-rich towns
  { city: 'Interlaken', country: 'Switzerland', region: 'BE' },
  { city: 'Montreux', country: 'Switzerland', region: 'VD' },
  { city: 'Zermatt', country: 'Switzerland', region: 'VS' },
  { city: 'Grindelwald', country: 'Switzerland', region: 'BE' },
  { city: 'Lauterbrunnen', country: 'Switzerland', region: 'BE' },
  { city: 'Rapperswil', country: 'Switzerland', region: 'SG' },
  { city: 'Stein am Rhein', country: 'Switzerland', region: 'SH' },
  { city: 'Murten', country: 'Switzerland', region: 'FR' },
  { city: 'Gruyères', country: 'Switzerland', region: 'FR' },
  { city: 'Appenzell', country: 'Switzerland', region: 'AI' },
  { city: 'Davos', country: 'Switzerland', region: 'GR' },
  { city: 'St. Moritz', country: 'Switzerland', region: 'GR' },
  { city: 'Ascona', country: 'Switzerland', region: 'TI' },
  { city: 'Bremgarten', country: 'Switzerland', region: 'AG' },
  { city: 'Rheinfelden', country: 'Switzerland', region: 'AG' },
  { city: 'Einsiedeln', country: 'Switzerland', region: 'SZ' },
  { city: 'Schwyz', country: 'Switzerland', region: 'SZ' },
  { city: 'Altdorf', country: 'Switzerland', region: 'UR' },
  { city: 'Stans', country: 'Switzerland', region: 'NW' },
  { city: 'Sarnen', country: 'Switzerland', region: 'OW' },
  { city: 'Glarus', country: 'Switzerland', region: 'GL' },
  { city: 'Liestal', country: 'Switzerland', region: 'BL' },
  { city: 'Delémont', country: 'Switzerland', region: 'JU' },
  { city: 'Herisau', country: 'Switzerland', region: 'AR' },
  // Additional landmark-rich locations
  { city: 'Avenches', country: 'Switzerland', region: 'VD' },
  { city: 'Romainmôtier', country: 'Switzerland', region: 'VD' },
  { city: 'Grandson', country: 'Switzerland', region: 'VD' },
  { city: 'Payerne', country: 'Switzerland', region: 'VD' },
  { city: 'Aigle', country: 'Switzerland', region: 'VD' },
  { city: 'Yverdon', country: 'Switzerland', region: 'VD' },
  { city: 'Nyon', country: 'Switzerland', region: 'VD' },
  { city: 'Morges', country: 'Switzerland', region: 'VD' },
  { city: 'Vevey', country: 'Switzerland', region: 'VD' },
  { city: 'Spiez', country: 'Switzerland', region: 'BE' },
  { city: 'Brienz', country: 'Switzerland', region: 'BE' },
  { city: 'Meiringen', country: 'Switzerland', region: 'BE' },
  { city: 'Burgdorf', country: 'Switzerland', region: 'BE' },
  { city: 'Langnau', country: 'Switzerland', region: 'BE' },
  { city: 'Brig', country: 'Switzerland', region: 'VS' },
  { city: 'Visp', country: 'Switzerland', region: 'VS' },
  { city: 'Leuk', country: 'Switzerland', region: 'VS' },
  { city: 'Sierre', country: 'Switzerland', region: 'VS' },
  { city: 'Martigny', country: 'Switzerland', region: 'VS' }
];

/**
 * Index landmarks for a list of cities (works for any city worldwide)
 * Can be used to bulk-index Swiss cities or any other cities
 * @param {Object} options - Options
 * @param {Array} options.cities - Array of {city, country, region} objects (defaults to SWISS_CITIES)
 * @param {boolean} options.analyzePhotos - Whether to analyze photos with AI (costs ~$0.15 total)
 * @param {Function} options.onProgress - Progress callback (city, current, total)
 * @returns {Promise<{total: number, saved: number, errors: number}>}
 */
async function indexLandmarksForCities(options = {}) {
  const {
    analyzePhotos = true,
    useMultiImageAnalysis = true,  // Use new multi-image quality analysis
    forceReanalyze = false,        // If true, re-analyze photos even if already have description
    onProgress = null,
    maxLandmarks = 500,  // Safety limit - default 500 landmarks max
    maxCities = null,    // Optional limit on cities to process
    filterCities = null, // Array of city names to process (for testing)
    dryRun = false       // If true, don't save to DB, just count
  } = options;

  // Use provided cities or default to SWISS_CITIES
  let cities = options.cities || SWISS_CITIES;
  if (filterCities && filterCities.length > 0) {
    cities = cities.filter(c => filterCities.some(f =>
      c.city.toLowerCase().includes(f.toLowerCase())
    ));
    log.info(`[LANDMARK-INDEX] Filtering to cities: ${cities.map(c => c.city).join(', ')}`);
  }

  const citiesToProcess = maxCities ? Math.min(maxCities, cities.length) : cities.length;

  log.info(`[LANDMARK-INDEX] Starting landmark indexing`);
  log.info(`[LANDMARK-INDEX]   Cities: ${citiesToProcess}/${cities.length}, maxLandmarks: ${maxLandmarks}, analyzePhotos: ${analyzePhotos}, multiImage: ${useMultiImageAnalysis}, dryRun: ${dryRun}`);

  const allLandmarks = new Map(); // qid -> landmark (for deduplication)
  let savedCount = 0;
  let analyzedCount = 0;
  let errorCount = 0;
  let hitLimit = false;

  for (let i = 0; i < citiesToProcess && !hitLimit; i++) {
    const { city, country = 'Switzerland', region } = cities[i];

    if (onProgress) {
      onProgress(city, i + 1, citiesToProcess, savedCount, maxLandmarks);
    }

    log.info(`[LANDMARK-INDEX] [${i + 1}/${citiesToProcess}] Discovering landmarks for ${city}, ${country}${region ? ` (${region})` : ''}... (saved: ${savedCount}/${maxLandmarks})`);

    try {
      // Get coordinates for city
      const coords = await geocodeCity(city, country);
      if (!coords) {
        log.warn(`[LANDMARK-INDEX] Could not geocode "${city}, ${country}", skipping`);
        continue;
      }

      // Search Wikipedia for landmarks (10km radius)
      const landmarks = await searchWikipediaLandmarks(coords.lat, coords.lon, 10000, null, country);

      log.info(`[LANDMARK-INDEX] Found ${landmarks.length} landmarks near ${city}`);

      for (const landmark of landmarks) {
        // Check if we hit the limit
        if (savedCount >= maxLandmarks) {
          log.warn(`[LANDMARK-INDEX] ⚠️ Reached maxLandmarks limit (${maxLandmarks}), stopping`);
          hitLimit = true;
          break;
        }

        // Skip if already found (deduplicate by QID)
        if (landmark.qid && allLandmarks.has(landmark.qid)) {
          continue;
        }

        // Add city/country/region info
        landmark.nearestCity = city;
        landmark.country = country;
        landmark.region = region;

        // Calculate score based on type
        // Higher score = more visually interesting landmark
        const HIGH_BOOST_TYPES = ['Castle', 'Church', 'Cathedral', 'Bridge', 'Tower', 'Abbey', 'Monastery', 'Chapel'];
        const MEDIUM_BOOST_TYPES = ['Park', 'Garden', 'Monument', 'Museum', 'Theatre', 'Historic site', 'Statue', 'Fountain', 'Square', 'Library'];

        let score = 0;
        if (HIGH_BOOST_TYPES.includes(landmark.type)) {
          score = 130;  // Iconic landmarks: castles, churches, bridges
        } else if (MEDIUM_BOOST_TYPES.includes(landmark.type)) {
          score = 80;   // Good landmarks: parks, museums, monuments
        } else if (landmark.type && !['Unknown', 'Building', 'Station'].includes(landmark.type)) {
          score = 30;   // Other specific types
        } else {
          score = 5;    // Generic or unknown
        }
        landmark.score = score;

        // Fetch and analyze photo if requested
        if (analyzePhotos && (forceReanalyze || !landmark.photoDescription)) {
          try {
            if (useMultiImageAnalysis) {
              // Strategy:
              // 1. Try Wikipedia article images first (correct location guaranteed)
              // Returns up to 2 exterior + 2 interior photos
              const bestResult = await findBestLandmarkImage(
                landmark.name,
                landmark.type,
                landmark.lang,      // Wikipedia language
                landmark.pageId,    // Wikipedia page ID for article images
                landmark.qid,       // Wikidata QID for Commons category lookup
                region,             // Region for location context
                country             // Country for location context
              );

              if (bestResult) {
                const { exteriorImages, interiorImages } = bestResult;

                // Save exterior images (photo_url, photo_url_2, photo_url_3) - 3 variants
                // These should be diverse (different angles/perspectives)
                if (exteriorImages.length > 0) {
                  landmark.photoUrl = exteriorImages[0].url;
                  landmark.attribution = exteriorImages[0].attribution;
                  landmark.photoDescription = exteriorImages[0].description;
                  landmark.photoScore = exteriorImages[0].score;
                  landmark.photoSource = bestResult.source;
                }
                if (exteriorImages.length > 1) {
                  landmark.photoUrl2 = exteriorImages[1].url;
                  landmark.attribution2 = exteriorImages[1].attribution;
                  landmark.photoDescription2 = exteriorImages[1].description;
                }
                if (exteriorImages.length > 2) {
                  landmark.photoUrl3 = exteriorImages[2].url;
                  landmark.attribution3 = exteriorImages[2].attribution;
                  landmark.photoDescription3 = exteriorImages[2].description;
                }

                // Save interior images (photo_url_4, photo_url_5, photo_url_6) - 3 variants
                if (interiorImages.length > 0) {
                  landmark.photoUrl4 = interiorImages[0].url;
                  landmark.attribution4 = interiorImages[0].attribution;
                  landmark.photoDescription4 = interiorImages[0].description;
                }
                if (interiorImages.length > 1) {
                  landmark.photoUrl5 = interiorImages[1].url;
                  landmark.attribution5 = interiorImages[1].attribution;
                  landmark.photoDescription5 = interiorImages[1].description;
                }
                if (interiorImages.length > 2) {
                  landmark.photoUrl6 = interiorImages[2].url;
                  landmark.attribution6 = interiorImages[2].attribution;
                  landmark.photoDescription6 = interiorImages[2].description;
                }

                // Add to landmark score based on photo quality
                if (exteriorImages.length > 0) {
                  landmark.score += Math.round(exteriorImages[0].score / 2);
                }
                analyzedCount++;

                const totalImages = exteriorImages.length + interiorImages.length;
                log.debug(`[LANDMARK-INDEX] ✅ "${landmark.name}": ${exteriorImages.length} ext + ${interiorImages.length} int`);
              } else {
                log.debug(`[LANDMARK-INDEX] No suitable image found for "${landmark.name}"`);
              }

              // Fetch Wikipedia extract for landmark description
              if (landmark.lang && landmark.pageId) {
                const extract = await fetchWikipediaExtract(landmark.lang, landmark.pageId, 3);
                if (extract) {
                  landmark.wikipediaExtract = extract;
                }
              }
            } else {
              // Old single-image approach (fallback)
              const photoResult = await fetchLandmarkPhoto(landmark.name, landmark.pageId, landmark.lang);
              if (photoResult && photoResult.photoData) {
                landmark.photoUrl = photoResult.photoUrl || `https://${landmark.lang}.wikipedia.org/wiki/${encodeURIComponent(landmark.name)}`;
                landmark.attribution = photoResult.attribution;
                const description = await analyzeLandmarkPhoto(photoResult.photoData, landmark.name, landmark.type);
                if (description && description !== 'undefined') {
                  landmark.photoDescription = description;
                  analyzedCount++;
                }
              }
            }
          } catch (err) {
            log.debug(`[LANDMARK-INDEX] Photo fetch failed for "${landmark.name}": ${err.message}`);
          }
        }

        // Save to database (unless dry run)
        if (dryRun) {
          savedCount++;
          if (landmark.qid) {
            allLandmarks.set(landmark.qid, landmark);
          }
          log.debug(`[LANDMARK-INDEX] [DRY RUN] Would save: "${landmark.name}" (${landmark.type})`);
        } else {
          const saved = await saveLandmarkToIndex(landmark);
          if (saved) {
            savedCount++;
            if (landmark.qid) {
              allLandmarks.set(landmark.qid, landmark);
            }
          } else {
            errorCount++;
          }
        }

        // Rate limiting
        await new Promise(r => setTimeout(r, 100));
      }

      // Delay between cities
      await new Promise(r => setTimeout(r, 500));

    } catch (err) {
      log.error(`[LANDMARK-INDEX] Error processing ${city}: ${err.message}`);
      errorCount++;
    }
  }

  const total = allLandmarks.size;
  log.info(`[LANDMARK-INDEX] ✅ Complete! Total unique: ${total}, Saved: ${savedCount}, Analyzed: ${analyzedCount}, Errors: ${errorCount}, HitLimit: ${hitLimit}`);

  return {
    totalDiscovered: total,
    totalSaved: savedCount,
    totalAnalyzed: analyzedCount,
    errors: errorCount,
    hitLimit,
    dryRun
  };
}

/**
 * Index landmarks for a single city (on-demand when user from new city arrives)
 * @param {string} city - City name
 * @param {string} country - Country name
 * @param {Object} options - Additional options (analyzePhotos, maxLandmarks, etc.)
 * @returns {Promise<{totalDiscovered: number, totalSaved: number}>}
 */
async function indexLandmarksForCity(city, country, options = {}) {
  log.info(`[LANDMARK-INDEX] Indexing landmarks for ${city}, ${country}...`);

  return indexLandmarksForCities({
    ...options,
    cities: [{ city, country, region: null }],
    maxLandmarks: options.maxLandmarks || 30,  // Lower limit for single city
    analyzePhotos: options.analyzePhotos !== false
  });
}

// ============================================================================
// LAZY PHOTO VARIANT LOADING - Load descriptions first, photos on-demand
// ============================================================================

/**
 * Load photo variant descriptions for all indexed landmarks in the Visual Bible
 * This is called after linkPreDiscoveredLandmarks to populate descriptions
 * WITHOUT loading actual image data (lazy loading)
 * @param {Object} visualBible - Visual Bible with locations array
 * @returns {Promise<Object>} Updated Visual Bible
 */
async function loadLandmarkPhotoDescriptions(visualBible) {
  if (!visualBible?.locations) return visualBible;

  // Find indexed landmarks that have photo variants (supports both old isSwissPreIndexed and new isIndexed)
  const indexedLandmarks = visualBible.locations.filter(
    loc => loc.isRealLandmark && (loc.isSwissPreIndexed || loc.isIndexed) && (loc.swissLandmarkId || loc.landmarkIndexId)
  );

  if (indexedLandmarks.length === 0) {
    log.debug('[LANDMARK-VARIANTS] No indexed landmarks to load descriptions for');
    return visualBible;
  }

  log.info(`[LANDMARK-VARIANTS] Loading photo descriptions for ${indexedLandmarks.length} indexed landmark(s)`);

  const pool = getPool();
  if (!pool) {
    log.warn('[LANDMARK-VARIANTS] No database pool available');
    return visualBible;
  }

  try {
    // Get landmark IDs (support both old and new field names)
    const ids = indexedLandmarks.map(l => l.swissLandmarkId || l.landmarkIndexId);

    // Query all photo descriptions for these landmarks (6 variants)
    const result = await pool.query(`
      SELECT id, name,
        photo_url, photo_description, photo_attribution,
        photo_url_2, photo_description_2, photo_attribution_2,
        photo_url_3, photo_description_3, photo_attribution_3,
        photo_url_4, photo_description_4, photo_attribution_4,
        photo_url_5, photo_description_5, photo_attribution_5,
        photo_url_6, photo_description_6, photo_attribution_6
      FROM landmark_index
      WHERE id = ANY($1)
    `, [ids]);

    // Build a lookup map
    const descriptionMap = new Map();
    for (const row of result.rows) {
      const variants = [];

      // Add variants 1-6 if they exist
      const variantConfigs = [
        { num: 1, url: row.photo_url, desc: row.photo_description, attr: row.photo_attribution },
        { num: 2, url: row.photo_url_2, desc: row.photo_description_2, attr: row.photo_attribution_2 },
        { num: 3, url: row.photo_url_3, desc: row.photo_description_3, attr: row.photo_attribution_3 },
        { num: 4, url: row.photo_url_4, desc: row.photo_description_4, attr: row.photo_attribution_4 },
        { num: 5, url: row.photo_url_5, desc: row.photo_description_5, attr: row.photo_attribution_5 },
        { num: 6, url: row.photo_url_6, desc: row.photo_description_6, attr: row.photo_attribution_6 }
      ];

      for (const cfg of variantConfigs) {
        if (cfg.url) {
          variants.push({
            variantNumber: cfg.num,
            url: cfg.url,
            description: cfg.desc || null,
            attribution: cfg.attr || null
          });
        }
      }

      descriptionMap.set(row.id, variants);
    }

    // Update Visual Bible locations with photo variants
    for (const loc of indexedLandmarks) {
      const landmarkId = loc.swissLandmarkId || loc.landmarkIndexId;
      const variants = descriptionMap.get(landmarkId);
      if (variants && variants.length > 0) {
        loc.photoVariants = variants;
        log.debug(`[LANDMARK-VARIANTS] "${loc.name}" has ${variants.length} photo variant(s)`);
      }
    }

    const withVariants = indexedLandmarks.filter(l => l.photoVariants?.length > 0).length;
    log.info(`[LANDMARK-VARIANTS] ✅ Loaded descriptions for ${withVariants}/${indexedLandmarks.length} landmarks`);

  } catch (err) {
    log.error(`[LANDMARK-VARIANTS] Error loading descriptions: ${err.message}`);
  }

  return visualBible;
}

/**
 * Load a specific photo variant on-demand
 * Fetches the image URL, compresses to JPEG, and caches the result
 * @param {Object} visualBible - Visual Bible with locations array
 * @param {string} locId - Location ID (e.g., "LOC001")
 * @param {number} variantNumber - Which variant to load (1-4, default 1)
 * @returns {Promise<{photoData: string, attribution: string, variantNumber: number}|null>}
 */
async function loadLandmarkPhotoVariant(visualBible, locId, variantNumber = 1) {
  if (!visualBible?.locations) return null;

  // Find the location
  const location = visualBible.locations.find(loc => loc.id === locId);
  if (!location) {
    log.debug(`[LANDMARK-VARIANT] Location not found: ${locId}`);
    return null;
  }

  // Check if we have variants loaded
  if (!location.photoVariants || location.photoVariants.length === 0) {
    // Fall back to existing referencePhotoData if available
    if (location.referencePhotoData) {
      return {
        photoData: location.referencePhotoData,
        attribution: location.photoAttribution || 'Unknown',
        variantNumber: 1
      };
    }
    log.debug(`[LANDMARK-VARIANT] No variants for "${location.name}"`);
    return null;
  }

  // Clamp variant number to available range
  const maxVariant = location.photoVariants.length;
  const safeVariantNumber = Math.min(Math.max(1, variantNumber), maxVariant);

  if (variantNumber !== safeVariantNumber) {
    log.debug(`[LANDMARK-VARIANT] Requested variant ${variantNumber} but only ${maxVariant} available, using ${safeVariantNumber}`);
  }

  const variant = location.photoVariants[safeVariantNumber - 1];
  if (!variant?.url) {
    log.debug(`[LANDMARK-VARIANT] No URL for variant ${safeVariantNumber} of "${location.name}"`);
    return null;
  }

  // Check if already cached on the variant object
  if (variant.cachedPhotoData) {
    log.debug(`[LANDMARK-VARIANT] Cache hit for "${location.name}" variant ${safeVariantNumber}`);
    return {
      photoData: variant.cachedPhotoData,
      attribution: variant.attribution || 'Wikimedia Commons',
      variantNumber: safeVariantNumber
    };
  }

  // Fetch and compress the image
  log.info(`[LANDMARK-VARIANT] Loading "${location.name}" variant ${safeVariantNumber}...`);

  try {
    const response = await fetch(variant.url, {
      headers: WIKI_HEADERS,
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      log.warn(`[LANDMARK-VARIANT] Failed to fetch variant ${safeVariantNumber}: HTTP ${response.status}`);
      return null;
    }

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const mimeType = contentType.split(';')[0].trim();

    // Compress to JPEG
    const photoData = await compressImageToJPEG(`data:${mimeType};base64,${base64}`, 85, 800);

    // Cache on the variant object for reuse
    variant.cachedPhotoData = photoData;

    const sizeKB = Math.round(photoData.length * 0.75 / 1024);
    log.info(`[LANDMARK-VARIANT] ✅ Loaded "${location.name}" variant ${safeVariantNumber} (${sizeKB}KB)`);

    return {
      photoData,
      attribution: variant.attribution || 'Wikimedia Commons',
      variantNumber: safeVariantNumber
    };

  } catch (err) {
    log.error(`[LANDMARK-VARIANT] Error loading variant ${safeVariantNumber} for "${location.name}": ${err.message}`);
    return null;
  }
}

/**
 * Get stats about the landmark_index table
 * @returns {Promise<{count: number, withDescriptions: number, byType: Object, byCountry: Object}>}
 */
async function getLandmarkIndexStats() {
  const pool = getPool();
  if (!pool) return { count: 0, withDescriptions: 0, byType: {} };

  try {
    const countResult = await pool.query('SELECT COUNT(*) as count FROM landmark_index');
    const descResult = await pool.query('SELECT COUNT(*) as count FROM landmark_index WHERE photo_description IS NOT NULL');
    const typeResult = await pool.query('SELECT type, COUNT(*) as count FROM landmark_index GROUP BY type ORDER BY count DESC');

    const byType = {};
    for (const row of typeResult.rows) {
      byType[row.type || 'Unknown'] = parseInt(row.count);
    }

    return {
      count: parseInt(countResult.rows[0].count),
      withDescriptions: parseInt(descResult.rows[0].count),
      byType
    };
  } catch (err) {
    log.error(`[LANDMARK-INDEX] Stats error: ${err.message}`);
    return { count: 0, withDescriptions: 0, byType: {} };
  }
}

module.exports = {
  fetchLandmarkPhoto,
  prefetchLandmarkPhotos,
  discoverLandmarksForLocation,
  searchLandmarksByText,
  searchLandmarksByCoordinates,
  geocodeCity,
  clearCache,
  getCacheStats,

  // Indexed landmarks (works for any city worldwide)
  getLandmarkPhotoOnDemand,
  getIndexedLandmarksNearLocation,
  getIndexedLandmarks,
  getAllIndexedLandmarks,
  saveLandmarkToIndex,
  indexLandmarksForCities,
  indexLandmarksForCity,  // Single city on-demand indexing
  getLandmarkIndexStats,
  SWISS_CITIES,  // Pre-configured Swiss cities list

  // Lazy photo variant loading
  loadLandmarkPhotoDescriptions,
  loadLandmarkPhotoVariant
};
