/**
 * Landmark Photo Service
 *
 * Fetches reference photos for real-world landmarks from Wikimedia Commons / Openverse
 * to improve image generation accuracy for famous buildings, monuments, etc.
 */

const { log } = require('../utils/logger');

// Simple in-memory cache (24-hour TTL)
const photoCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetch photo from Wikimedia Commons API
 * @param {string} query - Search query (e.g., "Eiffel Tower Paris")
 * @returns {Promise<{url: string, attribution: string, thumbnailUrl: string} | null>}
 */
async function fetchFromWikimedia(query) {
  try {
    // Search for images in File namespace (namespace 6)
    const searchUrl = `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query + ' landmark')}&srnamespace=6&srlimit=5&format=json&origin=*`;

    log.debug(`[LANDMARK] Wikimedia search: ${query}`);
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();

    if (!searchData.query?.search?.length) {
      log.debug(`[LANDMARK] Wikimedia: no results for "${query}"`);
      return null;
    }

    // Get first image result
    const fileName = searchData.query.search[0].title;
    log.debug(`[LANDMARK] Wikimedia found: ${fileName}`);

    // Get image URL and metadata
    const infoUrl = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(fileName)}&prop=imageinfo&iiprop=url|user|extmetadata&iiurlwidth=1024&format=json&origin=*`;
    const infoRes = await fetch(infoUrl);
    const infoData = await infoRes.json();

    const pages = infoData.query?.pages;
    const page = pages ? Object.values(pages)[0] : null;
    const imageInfo = page?.imageinfo?.[0];

    if (!imageInfo?.url) {
      log.debug(`[LANDMARK] Wikimedia: no image URL for "${fileName}"`);
      return null;
    }

    // Use thumbnail URL if available (smaller, faster to download)
    const imageUrl = imageInfo.thumburl || imageInfo.url;

    return {
      url: imageUrl,
      originalUrl: imageInfo.url,
      attribution: `Photo by ${imageInfo.user || 'Unknown'} via Wikimedia Commons`,
      license: imageInfo.extmetadata?.LicenseShortName?.value || 'CC'
    };
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
    const photoData = await downloadAsBase64(result.url);

    const photoResult = {
      photoUrl: result.url,
      photoData,
      attribution: result.attribution,
      source,
      license: result.license
    };

    // Cache the successful result
    photoCache.set(cacheKey, { data: photoResult, timestamp: Date.now() });

    log.info(`[LANDMARK] ✅ Fetched photo for "${landmarkQuery}" from ${source}`);
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

  // Find locations marked as real landmarks
  const landmarks = visualBible.locations.filter(
    loc => loc.isRealLandmark && loc.landmarkQuery
  );

  if (landmarks.length === 0) {
    log.debug(`[LANDMARK] No real landmarks found in Visual Bible`);
    return visualBible;
  }

  log.info(`[LANDMARK] 🌍 Pre-fetching photos for ${landmarks.length} real landmark(s)`);
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

module.exports = {
  fetchLandmarkPhoto,
  prefetchLandmarkPhotos,
  clearCache,
  getCacheStats
};
