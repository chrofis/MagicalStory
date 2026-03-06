#!/usr/bin/env node
/**
 * Pre-fetch Historical Location Images
 *
 * This script parses LOCATION_REFERENCES from historical-guides.txt,
 * fetches multiple candidate images from Wikimedia for each location,
 * evaluates them with Gemini, and stores the top 2 per location.
 *
 * Usage: node server/scripts/prefetch-historical-locations.js [--refresh]
 *
 * Options:
 *   --refresh  Re-fetch all images even if already in databank
 */

const fs = require('fs');
const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const GUIDES_FILE = path.join(__dirname, '../../prompts/historical-guides.txt');
const OUTPUT_FILE = path.join(__dirname, '../data/historical-locations.json');

// Wikimedia API headers
const WIKI_HEADERS = {
  'User-Agent': 'MagicalStory/1.0 (https://magicalstory.ch; contact@magicalstory.ch) Node.js',
  'Accept': 'application/json'
};

/**
 * Parse LOCATION_REFERENCES from historical-guides.txt
 * Returns: { eventId: [{ name, query, type }] }
 */
function parseLocationReferences() {
  const content = fs.readFileSync(GUIDES_FILE, 'utf-8');
  const lines = content.split('\n');

  const locations = {};
  let currentEvent = null;
  let inLocationRefs = false;

  for (const line of lines) {
    // Detect event header [event-id]
    const eventMatch = line.match(/^\[([a-z0-9-]+)\]$/);
    if (eventMatch) {
      currentEvent = eventMatch[1];
      locations[currentEvent] = [];
      inLocationRefs = false;
      continue;
    }

    // Detect LOCATION_REFERENCES section
    if (line.startsWith('LOCATION_REFERENCES:')) {
      inLocationRefs = true;
      continue;
    }

    // End of LOCATION_REFERENCES section
    if (inLocationRefs && (line.startsWith('STORY ANGLES:') || line.startsWith('KEY ') || line.match(/^[A-Z]+:/))) {
      inLocationRefs = false;
      continue;
    }

    // Parse location reference line
    if (inLocationRefs && line.trim().startsWith('- ')) {
      const parts = line.trim().substring(2).split(' | ');
      if (parts.length >= 2 && currentEvent) {
        locations[currentEvent].push({
          name: parts[0].trim(),
          query: parts[1].trim(),
          type: parts[2]?.trim() || 'Location'
        });
      }
    }
  }

  // Filter out events with no location references
  return Object.fromEntries(
    Object.entries(locations).filter(([, locs]) => locs.length > 0)
  );
}

/**
 * Search Wikipedia for an article and get images from it
 * First tries to get the main infobox image, then pageimages
 * Returns up to 5 candidate images
 */
async function searchWikimediaImages(query, limit = 5) {
  try {
    const candidates = [];

    // Strategy 1: Get Wikipedia article's main image (pageimages API)
    const pageImagesUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(query)}&prop=pageimages|images&piprop=original&pilimit=1&imlimit=${limit}&format=json&origin=*`;

    const pageRes = await fetch(pageImagesUrl, { headers: WIKI_HEADERS });
    const pageData = await pageRes.json();

    const pages = pageData.query?.pages;
    const page = pages ? Object.values(pages)[0] : null;

    // Get main page image
    if (page?.original?.source) {
      candidates.push({
        url: page.original.source,
        attribution: 'Image via Wikipedia',
        license: 'CC'
      });
    }

    // Get other images from the article
    if (page?.images) {
      for (const img of page.images) {
        if (candidates.length >= limit) break;

        const fileName = img.title;
        const lowerName = fileName.toLowerCase();

        // Skip non-photo files
        if (lowerName.includes('icon') || lowerName.includes('logo') ||
            lowerName.includes('map') || lowerName.includes('flag') ||
            lowerName.includes('symbol') || lowerName.includes('diagram') ||
            lowerName.endsWith('.svg') || lowerName.endsWith('.pdf')) {
          continue;
        }

        // Get full image URL from Commons
        const infoUrl = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(fileName)}&prop=imageinfo&iiprop=url|user|extmetadata|mime&format=json&origin=*`;
        const infoRes = await fetch(infoUrl, { headers: WIKI_HEADERS });
        const infoData = await infoRes.json();

        const infoPages = infoData.query?.pages;
        const infoPage = infoPages ? Object.values(infoPages)[0] : null;
        const imageInfo = infoPage?.imageinfo?.[0];

        if (!imageInfo?.url) continue;

        const mime = imageInfo.mime || '';
        if (!mime.startsWith('image/')) continue;

        // Skip if already in candidates
        if (candidates.some(c => c.url === imageInfo.url)) continue;

        candidates.push({
          url: imageInfo.url,
          attribution: `Photo by ${imageInfo.user || 'Unknown'} via Wikimedia Commons`,
          license: imageInfo.extmetadata?.LicenseShortName?.value || 'CC'
        });
      }
    }

    // Strategy 2: If few results, also search Commons directly with simpler query
    if (candidates.length < 3) {
      const searchUrl = `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srnamespace=6&srlimit=10&format=json&origin=*`;

      const searchRes = await fetch(searchUrl, { headers: WIKI_HEADERS });
      const searchData = await searchRes.json();

      for (const result of searchData.query?.search || []) {
        if (candidates.length >= limit) break;

        const fileName = result.title;
        const lowerName = fileName.toLowerCase();

        // Skip non-photo files
        if (lowerName.endsWith('.pdf') || lowerName.endsWith('.svg') ||
            lowerName.endsWith('.webm') || lowerName.endsWith('.ogv') ||
            lowerName.endsWith('.ogg') || lowerName.endsWith('.djvu') ||
            lowerName.includes('icon') || lowerName.includes('logo') ||
            lowerName.includes('map') || lowerName.includes('diagram')) {
          continue;
        }

        // Get image URL
        const infoUrl = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(fileName)}&prop=imageinfo&iiprop=url|user|extmetadata|mime&format=json&origin=*`;
        const infoRes = await fetch(infoUrl, { headers: WIKI_HEADERS });
        const infoData = await infoRes.json();

        const infoPages = infoData.query?.pages;
        const infoPage = infoPages ? Object.values(infoPages)[0] : null;
        const imageInfo = infoPage?.imageinfo?.[0];

        if (!imageInfo?.url) continue;

        const mime = imageInfo.mime || '';
        if (!mime.startsWith('image/')) continue;

        // Skip if already in candidates
        if (candidates.some(c => c.url === imageInfo.url)) continue;

        candidates.push({
          url: imageInfo.url,
          attribution: `Photo by ${imageInfo.user || 'Unknown'} via Wikimedia Commons`,
          license: imageInfo.extmetadata?.LicenseShortName?.value || 'CC'
        });
      }
    }

    return candidates;
  } catch (err) {
    console.error(`  Error searching Wikimedia for "${query}":`, err.message);
    return [];
  }
}

/**
 * Download image and convert to base64
 */
async function downloadAsBase64(imageUrl) {
  const res = await fetch(imageUrl, {
    headers: { 'User-Agent': 'MagicalStory/1.0 (https://magicalstory.ch)' }
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const buffer = await res.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');

  let mimeType = 'image/jpeg';
  if (contentType.includes('png')) mimeType = 'image/png';
  else if (contentType.includes('webp')) mimeType = 'image/webp';

  return `data:${mimeType};base64,${base64}`;
}

/**
 * Compress image to JPEG (simple resize/compression)
 * Uses sharp if available, otherwise returns original
 */
async function compressImage(base64Data, maxSize = 768, quality = 80) {
  try {
    const sharp = require('sharp');
    const matches = base64Data.match(/^data:image\/\w+;base64,(.+)$/);
    if (!matches) return base64Data;

    const buffer = Buffer.from(matches[1], 'base64');
    const compressed = await sharp(buffer)
      .resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();

    return `data:image/jpeg;base64,${compressed.toString('base64')}`;
  } catch {
    // sharp not available, return original
    return base64Data;
  }
}

/**
 * Evaluate image quality using Gemini
 * Returns: { score: 1-10, reason: string, description: string }
 */
async function evaluateImage(photoData, locationName, locationType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { score: 5, reason: 'No Gemini API key', description: locationName };
  }

  const matches = photoData.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!matches) return { score: 0, reason: 'Invalid image data', description: '' };

  const [, mimeType, base64Data] = matches;

  const prompt = `Evaluate this photo of "${locationName}" (a ${locationType}) for use as a children's book illustration background.

Score 1-10 based on:
- Clarity: Is it sharp and well-lit? (not blurry or dark)
- Composition: Does it show the landmark clearly and completely?
- Suitability: Would it work as a book background? (not too busy, no distracting elements like people/cars/signs)
- Quality: Is it a good representative image of this place?

Also provide a 2-sentence description of what's visible in the photo for use in image generation prompts.

Return ONLY valid JSON (no markdown):
{"score": N, "reason": "brief explanation", "description": "2-sentence visual description"}`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inlineData: { mimeType, data: base64Data } }
          ]
        }],
        generationConfig: {
          maxOutputTokens: 300,
          temperature: 0.3
        }
      }),
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      console.error(`  Gemini API error: ${response.status}`);
      return { score: 5, reason: 'API error', description: locationName };
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!text) {
      return { score: 5, reason: 'No response', description: locationName };
    }

    // Parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    return { score: 5, reason: 'Parse error', description: locationName };
  } catch (err) {
    console.error(`  Gemini evaluation error:`, err.message);
    return { score: 5, reason: err.message, description: locationName };
  }
}

/**
 * Process a single location: fetch 5 images, evaluate, keep top 2
 */
async function processLocation(location, existingPhotos = []) {
  console.log(`  Processing: ${location.name} (${location.type})`);

  // Search for candidates
  const candidates = await searchWikimediaImages(location.query, 5);
  console.log(`    Found ${candidates.length} candidate images`);

  if (candidates.length === 0) {
    return { ...location, photos: existingPhotos };
  }

  // Download and evaluate each
  const evaluated = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      console.log(`    Evaluating image ${i + 1}/${candidates.length}...`);

      // Download
      let photoData = await downloadAsBase64(candidate.url);

      // Compress
      photoData = await compressImage(photoData, 768, 80);

      // Evaluate
      const evaluation = await evaluateImage(photoData, location.name, location.type);

      evaluated.push({
        photoUrl: candidate.url,
        photoData,
        attribution: candidate.attribution,
        description: evaluation.description,
        score: evaluation.score,
        reason: evaluation.reason
      });

      console.log(`      Score: ${evaluation.score}/10 - ${evaluation.reason}`);

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (err) {
      console.error(`    Error processing image:`, err.message);
    }
  }

  // Sort by score, keep top 2
  evaluated.sort((a, b) => b.score - a.score);
  const topPhotos = evaluated.slice(0, 2);

  console.log(`    Selected ${topPhotos.length} best images (scores: ${topPhotos.map(p => p.score).join(', ')})`);

  return {
    ...location,
    photos: topPhotos
  };
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');

  console.log('='.repeat(60));
  console.log('Historical Location Image Pre-fetcher');
  console.log('='.repeat(60));

  // Parse location references
  console.log('\nParsing LOCATION_REFERENCES from historical-guides.txt...');
  const allLocations = parseLocationReferences();

  const eventCount = Object.keys(allLocations).length;
  const locationCount = Object.values(allLocations).flat().length;
  console.log(`Found ${locationCount} locations across ${eventCount} events\n`);

  // Load existing databank if not refreshing
  let existingData = {};
  if (!refresh && fs.existsSync(OUTPUT_FILE)) {
    try {
      existingData = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
      console.log(`Loaded existing databank with ${Object.keys(existingData).length} events\n`);
    } catch {
      console.log('Could not load existing databank, starting fresh\n');
    }
  }

  // Process each event
  const results = {};
  let processedCount = 0;
  let skippedCount = 0;

  for (const [eventId, locations] of Object.entries(allLocations)) {
    console.log(`\n[${eventId}] - ${locations.length} location(s)`);

    const processedLocations = [];
    for (const location of locations) {
      // Check if already in databank (unless refreshing)
      const existingEvent = existingData[eventId];
      const existingLoc = existingEvent?.locations?.find(l => l.name === location.name);

      if (!refresh && existingLoc?.photos?.length > 0) {
        console.log(`  Skipping ${location.name} (already in databank)`);
        processedLocations.push(existingLoc);
        skippedCount++;
        continue;
      }

      // Process new location
      const processed = await processLocation(location);
      processedLocations.push(processed);
      processedCount++;

      // Save incrementally after each location
      results[eventId] = {
        locations: processedLocations,
        lastUpdated: new Date().toISOString()
      };

      // Merge with existing data
      const mergedResults = { ...existingData, ...results };
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(mergedResults, null, 2));
    }

    results[eventId] = {
      locations: processedLocations,
      lastUpdated: new Date().toISOString()
    };
  }

  // Final save
  const finalResults = { ...existingData, ...results };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalResults, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log('COMPLETE');
  console.log('='.repeat(60));
  console.log(`Processed: ${processedCount} locations`);
  console.log(`Skipped:   ${skippedCount} locations (already in databank)`);
  console.log(`Output:    ${OUTPUT_FILE}`);

  // Calculate file size
  const stats = fs.statSync(OUTPUT_FILE);
  const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
  console.log(`File size: ${sizeMB} MB`);
}

// Run
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
