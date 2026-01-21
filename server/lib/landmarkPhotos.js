/**
 * Landmark Photo Service
 *
 * Fetches reference photos for real-world landmarks from Wikimedia Commons / Openverse
 * to improve image generation accuracy for famous buildings, monuments, etc.
 */

const { log } = require('../utils/logger');
const { compressImageToJPEG } = require('./images');
const { getPool } = require('../services/database');

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
2. IS_LANDMARK_PHOTO: Does it show a building, monument, or natural landmark? (not a map, diagram, logo, portrait, or text)
3. VISUAL_INTEREST: Would it be interesting/recognizable in a children's book?
4. COMPOSITION: Is the main subject clearly visible and well-framed?${locationCheck}

Respond in this exact JSON format:
{
  "photoQuality": <1-10>,
  "isLandmarkPhoto": <1-10>,
  "visualInterest": <1-10>,
  "composition": <1-10>,${locationField}
  "isExterior": <true/false>,
  "issues": ["list any problems"],
  "description": "One sentence describing what's in the photo"
}`;

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
 * Find best images for a landmark
 * Strategy:
 * 1. Try Commons category (via Wikidata QID) - many images, guaranteed correct
 * 2. If not enough good ones, try Wikipedia article images
 * 3. If still not enough, fallback to Commons search with canton+Switzerland
 *
 * @param {string} landmarkName - Name of landmark
 * @param {string} landmarkType - Type of landmark (Castle, Church, etc.)
 * @param {string} lang - Wikipedia language code
 * @param {number} pageId - Wikipedia page ID (for article images)
 * @param {string} qid - Wikidata QID (for Commons category lookup)
 * @param {string} canton - Swiss canton code (e.g., "AG")
 * @param {number} topN - Number of best images to return (default 2)
 * @returns {Promise<{bestImages: Array, source: string}|null>}
 */
async function findBestLandmarkImage(landmarkName, landmarkType, lang = null, pageId = null, qid = null, canton = null, topN = 2) {
  log.info(`[BEST-IMG] Finding images for "${landmarkName}" (${landmarkType || 'unknown'})`);

  let candidates = [];
  let goodImages = [];

  // STEP 1: Try Commons category via Wikidata (best source - many correct images)
  if (qid) {
    const commonsCategory = await getCommonsCategoryFromWikidata(qid);
    if (commonsCategory) {
      log.debug(`[BEST-IMG] Trying Commons category: "${commonsCategory}"`);
      candidates = await fetchImagesFromCommonsCategory(commonsCategory, 10);

      if (candidates.length > 0) {
        goodImages = await analyzeAndFilterImages(candidates, landmarkName, null);  // No location check - category is correct

        if (goodImages.length >= topN) {
          const bestImages = goodImages.slice(0, topN);
          log.info(`[BEST-IMG] ✅ "${landmarkName}": ${bestImages.length} from Commons category, scores=[${bestImages.map(i => i.score).join(', ')}]`);
          return { bestImages, source: 'commons-category' };
        }
        log.debug(`[BEST-IMG] Commons category: ${goodImages.length} good images (need ${topN})`);
      }
    }
  }

  // STEP 2: Try Wikipedia article images (if we need more)
  if (goodImages.length < topN && lang && pageId) {
    log.debug(`[BEST-IMG] Trying Wikipedia article (${lang}:${pageId})...`);
    candidates = await fetchWikipediaArticleImages(lang, pageId, 6);

    if (candidates.length > 0) {
      const articleImages = await analyzeAndFilterImages(candidates, landmarkName, null);
      // Merge with existing good images, avoiding duplicates
      for (const img of articleImages) {
        if (!goodImages.some(g => g.url === img.url)) {
          goodImages.push(img);
        }
      }
      goodImages.sort((a, b) => b.score - a.score);  // Re-sort by score

      if (goodImages.length >= topN) {
        const bestImages = goodImages.slice(0, topN);
        log.info(`[BEST-IMG] ✅ "${landmarkName}": ${bestImages.length} from article+category, scores=[${bestImages.map(i => i.score).join(', ')}]`);
        return { bestImages, source: 'wikipedia-article' };
      }
    }
  }

  // STEP 3: Fallback to Commons search with location (if still need more)
  if (goodImages.length < 1) {
    log.debug(`[BEST-IMG] Trying Commons search with location...`);

    const locationSuffix = canton ? `${canton} Switzerland` : 'Switzerland';
    const searchQuery = `${landmarkName} ${locationSuffix}`;
    candidates = await fetchMultipleImages(searchQuery, 6, null);

    if (candidates.length > 0) {
      // Verify location since search can return wrong places
      const locationContext = canton ? `${canton}, Switzerland` : 'Switzerland';
      const searchImages = await analyzeAndFilterImages(candidates, landmarkName, locationContext);

      for (const img of searchImages) {
        if (!goodImages.some(g => g.url === img.url)) {
          goodImages.push(img);
        }
      }
      goodImages.sort((a, b) => b.score - a.score);
    }
  }

  if (goodImages.length === 0) {
    log.warn(`[BEST-IMG] No good images found for "${landmarkName}" from any source`);
    return null;
  }

  const bestImages = goodImages.slice(0, topN);
  log.info(`[BEST-IMG] ✅ "${landmarkName}": ${bestImages.length} images, scores=[${bestImages.map(i => i.score).join(', ')}]`);
  return { bestImages, source: goodImages.length > 0 ? 'combined' : 'commons-search' };
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
          photoData = await compressImageToJPEG(`data:${mimeType};base64,${base64}`, 800, 85);
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
 * Get pre-indexed Swiss landmarks near a location
 * @param {number} latitude
 * @param {number} longitude
 * @param {number} radiusKm - Search radius in kilometers (default 20km)
 * @param {number} limit - Maximum results (default 30)
 * @returns {Promise<Array>}
 */
async function getSwissLandmarksNearLocation(latitude, longitude, radiusKm = 20, limit = 30) {
  const pool = getPool();
  if (!pool) {
    log.warn('[SWISS-LANDMARKS] Database not available');
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
      FROM swiss_landmarks
      WHERE latitude BETWEEN $1 - $3 AND $1 + $3
        AND longitude BETWEEN $2 - $4 AND $2 + $4
      ORDER BY score DESC, distance_km ASC
      LIMIT $5
    `, [latitude, longitude, latDelta, lonDelta, limit]);

    log.info(`[SWISS-LANDMARKS] Found ${result.rows.length} landmarks within ${radiusKm}km of (${latitude}, ${longitude})`);
    return result.rows;
  } catch (err) {
    log.error(`[SWISS-LANDMARKS] Query error: ${err.message}`);
    return [];
  }
}

/**
 * Get pre-indexed Swiss landmarks by city name
 * @param {string} city - City name
 * @param {number} limit - Maximum results (default 30)
 * @returns {Promise<Array>}
 */
async function getSwissLandmarksByCity(city, limit = 30) {
  const pool = getPool();
  if (!pool) {
    log.warn('[SWISS-LANDMARKS] Database not available');
    return [];
  }

  try {
    const result = await pool.query(`
      SELECT * FROM swiss_landmarks
      WHERE LOWER(nearest_city) = LOWER($1)
      ORDER BY score DESC
      LIMIT $2
    `, [city, limit]);

    log.info(`[SWISS-LANDMARKS] Found ${result.rows.length} landmarks for city "${city}"`);
    return result.rows;
  } catch (err) {
    log.error(`[SWISS-LANDMARKS] Query error: ${err.message}`);
    return [];
  }
}

/**
 * Get all pre-indexed Swiss landmarks (for outline generation)
 * Returns top landmarks across all of Switzerland
 * @param {number} limit - Maximum results (default 100)
 * @returns {Promise<Array>}
 */
async function getAllSwissLandmarks(limit = 100) {
  const pool = getPool();
  if (!pool) {
    log.warn('[SWISS-LANDMARKS] Database not available');
    return [];
  }

  try {
    const result = await pool.query(`
      SELECT * FROM swiss_landmarks
      ORDER BY score DESC
      LIMIT $1
    `, [limit]);

    log.info(`[SWISS-LANDMARKS] Retrieved ${result.rows.length} top landmarks from index`);
    return result.rows;
  } catch (err) {
    log.error(`[SWISS-LANDMARKS] Query error: ${err.message}`);
    return [];
  }
}

/**
 * Save a landmark to the swiss_landmarks table
 * @param {Object} landmark - Landmark data
 * @returns {Promise<boolean>} - Success status
 */
async function saveSwissLandmark(landmark) {
  const pool = getPool();
  if (!pool) return false;

  // Normalize values - ensure we don't save "undefined" strings
  const normalize = (val) => (val === undefined || val === 'undefined' || val === '') ? null : val;

  try {
    await pool.query(`
      INSERT INTO swiss_landmarks (
        name, wikipedia_page_id, wikidata_qid, lang,
        latitude, longitude, nearest_city, canton,
        type, boost_amount, categories,
        photo_url, photo_attribution, photo_source, photo_description,
        photo_url_2, photo_attribution_2, photo_description_2,
        commons_photo_count, score
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      ON CONFLICT (wikidata_qid) DO UPDATE SET
        name = EXCLUDED.name,
        latitude = COALESCE(EXCLUDED.latitude, swiss_landmarks.latitude),
        longitude = COALESCE(EXCLUDED.longitude, swiss_landmarks.longitude),
        type = COALESCE(EXCLUDED.type, swiss_landmarks.type),
        photo_url = COALESCE(EXCLUDED.photo_url, swiss_landmarks.photo_url),
        photo_attribution = COALESCE(EXCLUDED.photo_attribution, swiss_landmarks.photo_attribution),
        photo_description = COALESCE(EXCLUDED.photo_description, swiss_landmarks.photo_description),
        photo_url_2 = COALESCE(EXCLUDED.photo_url_2, swiss_landmarks.photo_url_2),
        photo_attribution_2 = COALESCE(EXCLUDED.photo_attribution_2, swiss_landmarks.photo_attribution_2),
        photo_description_2 = COALESCE(EXCLUDED.photo_description_2, swiss_landmarks.photo_description_2),
        score = GREATEST(EXCLUDED.score, swiss_landmarks.score),
        updated_at = CURRENT_TIMESTAMP
    `, [
      landmark.name,
      landmark.pageId || landmark.wikipedia_page_id || null,
      landmark.qid || landmark.wikidata_qid,
      landmark.lang || null,
      landmark.lat || landmark.latitude || null,
      landmark.lon || landmark.longitude || null,
      landmark.nearestCity || landmark.nearest_city || null,
      landmark.canton || null,
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
      landmark.commonsPhotoCount || landmark.commons_photo_count || 0,
      landmark.score || 0
    ]);

    return true;
  } catch (err) {
    log.error(`[SWISS-LANDMARKS] Save error for "${landmark.name}": ${err.message}`);
    return false;
  }
}

/**
 * Swiss cities to crawl for landmark discovery
 * Covers all 26 cantons with major towns
 */
const SWISS_CITIES = [
  // Major cities
  { city: 'Zürich', canton: 'ZH' },
  { city: 'Genf', canton: 'GE' },
  { city: 'Basel', canton: 'BS' },
  { city: 'Lausanne', canton: 'VD' },
  { city: 'Bern', canton: 'BE' },
  { city: 'Winterthur', canton: 'ZH' },
  { city: 'Luzern', canton: 'LU' },
  { city: 'St. Gallen', canton: 'SG' },
  { city: 'Lugano', canton: 'TI' },
  { city: 'Biel', canton: 'BE' },
  // Medium cities
  { city: 'Thun', canton: 'BE' },
  { city: 'Fribourg', canton: 'FR' },
  { city: 'Schaffhausen', canton: 'SH' },
  { city: 'Chur', canton: 'GR' },
  { city: 'Neuchâtel', canton: 'NE' },
  { city: 'Sion', canton: 'VS' },
  { city: 'Aarau', canton: 'AG' },
  { city: 'Baden', canton: 'AG' },
  { city: 'Zug', canton: 'ZG' },
  { city: 'Solothurn', canton: 'SO' },
  { city: 'Olten', canton: 'SO' },
  { city: 'Bellinzona', canton: 'TI' },
  { city: 'Locarno', canton: 'TI' },
  // Smaller but landmark-rich towns
  { city: 'Interlaken', canton: 'BE' },
  { city: 'Montreux', canton: 'VD' },
  { city: 'Zermatt', canton: 'VS' },
  { city: 'Grindelwald', canton: 'BE' },
  { city: 'Lauterbrunnen', canton: 'BE' },
  { city: 'Rapperswil', canton: 'SG' },
  { city: 'Stein am Rhein', canton: 'SH' },
  { city: 'Murten', canton: 'FR' },
  { city: 'Gruyères', canton: 'FR' },
  { city: 'Appenzell', canton: 'AI' },
  { city: 'Davos', canton: 'GR' },
  { city: 'St. Moritz', canton: 'GR' },
  { city: 'Ascona', canton: 'TI' },
  { city: 'Bremgarten', canton: 'AG' },
  { city: 'Rheinfelden', canton: 'AG' },
  { city: 'Einsiedeln', canton: 'SZ' },
  { city: 'Schwyz', canton: 'SZ' },
  { city: 'Altdorf', canton: 'UR' },
  { city: 'Stans', canton: 'NW' },
  { city: 'Sarnen', canton: 'OW' },
  { city: 'Glarus', canton: 'GL' },
  { city: 'Liestal', canton: 'BL' },
  { city: 'Delémont', canton: 'JU' },
  { city: 'Herisau', canton: 'AR' },
  // Additional landmark-rich locations
  { city: 'Avenches', canton: 'VD' },
  { city: 'Romainmôtier', canton: 'VD' },
  { city: 'Grandson', canton: 'VD' },
  { city: 'Payerne', canton: 'VD' },
  { city: 'Aigle', canton: 'VD' },
  { city: 'Yverdon', canton: 'VD' },
  { city: 'Nyon', canton: 'VD' },
  { city: 'Morges', canton: 'VD' },
  { city: 'Vevey', canton: 'VD' },
  { city: 'Spiez', canton: 'BE' },
  { city: 'Brienz', canton: 'BE' },
  { city: 'Meiringen', canton: 'BE' },
  { city: 'Burgdorf', canton: 'BE' },
  { city: 'Langnau', canton: 'BE' },
  { city: 'Brig', canton: 'VS' },
  { city: 'Visp', canton: 'VS' },
  { city: 'Leuk', canton: 'VS' },
  { city: 'Sierre', canton: 'VS' },
  { city: 'Martigny', canton: 'VS' }
];

/**
 * Discover and index all Swiss landmarks
 * One-time crawl to populate swiss_landmarks table
 * @param {Object} options - Options
 * @param {boolean} options.analyzePhotos - Whether to analyze photos with AI (costs ~$0.15 total)
 * @param {Function} options.onProgress - Progress callback (city, current, total)
 * @returns {Promise<{total: number, saved: number, errors: number}>}
 */
async function discoverAllSwissLandmarks(options = {}) {
  const {
    analyzePhotos = true,
    useMultiImageAnalysis = true,  // Use new multi-image quality analysis
    onProgress = null,
    maxLandmarks = 500,  // Safety limit - default 500 landmarks max
    maxCities = null,    // Optional limit on cities to process
    filterCities = null, // Array of city names to process (for testing)
    dryRun = false       // If true, don't save to DB, just count
  } = options;

  // Filter to specific cities if provided, otherwise use all
  let cities = SWISS_CITIES;
  if (filterCities && filterCities.length > 0) {
    cities = SWISS_CITIES.filter(c => filterCities.some(f =>
      c.city.toLowerCase().includes(f.toLowerCase())
    ));
    log.info(`[SWISS-INDEX] Filtering to cities: ${cities.map(c => c.city).join(', ')}`);
  }

  const citiesToProcess = maxCities ? Math.min(maxCities, cities.length) : cities.length;

  log.info(`[SWISS-INDEX] Starting Swiss landmark discovery`);
  log.info(`[SWISS-INDEX]   Cities: ${citiesToProcess}/${cities.length}, maxLandmarks: ${maxLandmarks}, analyzePhotos: ${analyzePhotos}, multiImage: ${useMultiImageAnalysis}, dryRun: ${dryRun}`);

  const allLandmarks = new Map(); // qid -> landmark (for deduplication)
  let savedCount = 0;
  let analyzedCount = 0;
  let errorCount = 0;
  let hitLimit = false;

  for (let i = 0; i < citiesToProcess && !hitLimit; i++) {
    const { city, canton } = cities[i];

    if (onProgress) {
      onProgress(city, i + 1, citiesToProcess, savedCount, maxLandmarks);
    }

    log.info(`[SWISS-INDEX] [${i + 1}/${citiesToProcess}] Discovering landmarks for ${city} (${canton})... (saved: ${savedCount}/${maxLandmarks})`);

    try {
      // Get coordinates for city
      const coords = await geocodeCity(city, 'Switzerland');
      if (!coords) {
        log.warn(`[SWISS-INDEX] Could not geocode "${city}", skipping`);
        continue;
      }

      // Search Wikipedia for landmarks (10km radius)
      const landmarks = await searchWikipediaLandmarks(coords.lat, coords.lon, 10000, null, 'Switzerland');

      log.info(`[SWISS-INDEX] Found ${landmarks.length} landmarks near ${city}`);

      for (const landmark of landmarks) {
        // Check if we hit the limit
        if (savedCount >= maxLandmarks) {
          log.warn(`[SWISS-INDEX] ⚠️ Reached maxLandmarks limit (${maxLandmarks}), stopping`);
          hitLimit = true;
          break;
        }

        // Skip if already found (deduplicate by QID)
        if (landmark.qid && allLandmarks.has(landmark.qid)) {
          continue;
        }

        // Add city/canton info
        landmark.nearestCity = city;
        landmark.canton = canton;

        // Calculate score based on type and boost
        // Higher score = more visually interesting landmark
        let score = 0;
        if (landmark.boostAmount === 100) score += 100;  // Tourist attractions, castles, churches
        else if (landmark.boostAmount === 50) score += 50;  // Parks, monuments, historic
        if (landmark.type && !['Unknown', 'Building', 'Station'].includes(landmark.type)) {
          score += 25;  // Has a specific type (not generic)
        }
        landmark.score = score;

        // Fetch and analyze photo if requested
        if (analyzePhotos && !landmark.photoDescription) {
          try {
            if (useMultiImageAnalysis) {
              // Strategy:
              // 1. Try Wikipedia article images first (correct location guaranteed)
              // 2. If not enough good ones, fallback to Wikimedia Commons with canton+Switzerland in search
              const bestResult = await findBestLandmarkImage(
                landmark.name,
                landmark.type,
                landmark.lang,      // Wikipedia language
                landmark.pageId,    // Wikipedia page ID for article images
                landmark.qid,       // Wikidata QID for Commons category lookup
                canton,             // Swiss canton for location context
                2                   // Get top 2 images
              );

              if (bestResult && bestResult.bestImages && bestResult.bestImages.length > 0) {
                // Save first (best) image
                const best = bestResult.bestImages[0];
                landmark.photoUrl = best.url;
                landmark.attribution = best.attribution;
                landmark.photoDescription = best.description;
                landmark.photoScore = best.score;
                landmark.photoIsExterior = best.isExterior;
                landmark.photoSource = bestResult.source;

                // Save second image if available
                if (bestResult.bestImages.length > 1) {
                  const second = bestResult.bestImages[1];
                  landmark.photoUrl2 = second.url;
                  landmark.attribution2 = second.attribution;
                  landmark.photoDescription2 = second.description;
                }

                // Add to landmark score based on photo quality
                landmark.score += Math.round(best.score / 2);  // +0 to +5 points
                analyzedCount++;
                log.debug(`[SWISS-INDEX] ✅ "${landmark.name}": ${bestResult.bestImages.length} images from ${bestResult.source}, scores=[${bestResult.bestImages.map(i => i.score).join(', ')}]`);
              } else {
                log.debug(`[SWISS-INDEX] No suitable image found for "${landmark.name}"`);
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
            log.debug(`[SWISS-INDEX] Photo fetch failed for "${landmark.name}": ${err.message}`);
          }
        }

        // Save to database (unless dry run)
        if (dryRun) {
          savedCount++;
          if (landmark.qid) {
            allLandmarks.set(landmark.qid, landmark);
          }
          log.debug(`[SWISS-INDEX] [DRY RUN] Would save: "${landmark.name}" (${landmark.type})`);
        } else {
          const saved = await saveSwissLandmark(landmark);
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
      log.error(`[SWISS-INDEX] Error processing ${city}: ${err.message}`);
      errorCount++;
    }
  }

  const total = allLandmarks.size;
  log.info(`[SWISS-INDEX] ✅ Complete! Total unique: ${total}, Saved: ${savedCount}, Analyzed: ${analyzedCount}, Errors: ${errorCount}, HitLimit: ${hitLimit}`);

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
 * Get stats about the swiss_landmarks table
 * @returns {Promise<{count: number, withDescriptions: number, byType: Object}>}
 */
async function getSwissLandmarkStats() {
  const pool = getPool();
  if (!pool) return { count: 0, withDescriptions: 0, byType: {} };

  try {
    const countResult = await pool.query('SELECT COUNT(*) as count FROM swiss_landmarks');
    const descResult = await pool.query('SELECT COUNT(*) as count FROM swiss_landmarks WHERE photo_description IS NOT NULL');
    const typeResult = await pool.query('SELECT type, COUNT(*) as count FROM swiss_landmarks GROUP BY type ORDER BY count DESC');

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
    log.error(`[SWISS-LANDMARKS] Stats error: ${err.message}`);
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

  // Swiss pre-indexed landmarks
  getLandmarkPhotoOnDemand,
  getSwissLandmarksNearLocation,
  getSwissLandmarksByCity,
  getAllSwissLandmarks,
  saveSwissLandmark,
  discoverAllSwissLandmarks,
  getSwissLandmarkStats,
  SWISS_CITIES
};
