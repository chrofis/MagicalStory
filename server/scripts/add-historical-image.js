#!/usr/bin/env node
/**
 * Add Historical Location Image
 *
 * Fetches an image from Wikimedia Commons, evaluates it with Gemini,
 * and saves it to the local folder structure for later sync.
 *
 * Usage: node server/scripts/add-historical-image.js <wikimedia-url> <event-id> <location-name>
 *
 * Example:
 *   node server/scripts/add-historical-image.js "https://commons.wikimedia.org/wiki/File:Example.jpg" "moon-landing" "Kennedy Space Center"
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const IMAGES_FOLDER = path.join(__dirname, '../../historical-location-images');
const DATABANK_FILE = path.join(__dirname, '../data/historical-locations.json');

// Event ID to display name mapping
const EVENT_NAMES = {
  'moon-landing': 'Moon Landing (1969)',
  'wright-brothers': 'Wright Brothers First Flight (1903)',
  'lindbergh-flight': 'Lindbergh Transatlantic Flight (1927)',
  'everest-summit': 'Everest First Summit (1953)',
  'berlin-wall-fall': 'Berlin Wall Fall (1989)',
  'mandela-freedom': 'Mandela Freedom (1990)',
  'pyramids': 'Pyramids of Giza',
  'eiffel-tower': 'Eiffel Tower Construction (1889)',
  'panama-canal': 'Panama Canal Opening (1914)',
  'golden-gate-bridge': 'Golden Gate Bridge (1937)',
  'channel-tunnel': 'Channel Tunnel Opening (1994)',
  'titanic': 'Titanic (1912)',
  'pompeii': 'Pompeii Discovery',
  'tutankhamun-tomb': 'Tutankhamun Tomb Discovery (1922)',
  'terracotta-army': 'Terracotta Army Discovery (1974)',
  'gutenberg-printing': 'Gutenberg Printing Press (1450)',
  'dna-discovery': 'DNA Discovery (1953)',
  'first-olympics': 'First Modern Olympics (1896)',
  'woodstock': 'Woodstock Festival (1969)',
  'disneyland-opening': 'Disneyland Opening (1955)',
  'hubble-telescope': 'Hubble Telescope Launch (1990)',
  'internet-birth': 'Internet Birth (1969)',
  'swiss-confederation': 'Swiss Confederation (1291)',
  'battle-morgarten': 'Battle of Morgarten (1315)',
  'battle-sempach': 'Battle of Sempach (1386)',
  'battle-murten': 'Battle of Murten (1476)',
  'reformation-zurich': 'Reformation Zurich (1519)',
  'helvetic-republic': 'Helvetic Republic (1798)',
  'federal-constitution': 'Swiss Federal Constitution (1848)',
  'red-cross-founding': 'Red Cross Founding (1863)',
  'gotthard-tunnel': 'Gotthard Tunnel (1882)',
  'womens-suffrage-ch': 'Swiss Women\'s Suffrage (1971)',
};

/**
 * Convert location name to slug
 */
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Get image URL from Wikimedia Commons page URL
 */
async function getWikimediaImageUrl(pageUrl) {
  // Handle direct upload.wikimedia.org URLs
  if (pageUrl.includes('upload.wikimedia.org')) {
    const urlParts = pageUrl.split('/');
    const fileName = decodeURIComponent(urlParts[urlParts.length - 1]).replace(/_/g, ' ');
    console.log(`  Direct URL detected`);
    console.log(`  File name: ${fileName}`);
    return {
      url: pageUrl,
      attribution: 'Photo via Wikimedia Commons',
      license: 'Public Domain'
    };
  }

  // Extract file name from Commons page URL
  const match = pageUrl.match(/File:(.+?)(?:\?|$|#)/i) || pageUrl.match(/File:(.+)/i);
  if (!match) {
    throw new Error('Could not extract file name from URL');
  }

  const fileName = decodeURIComponent(match[1]).replace(/_/g, ' ');
  console.log(`  File name: ${fileName}`);

  // Query Wikimedia API for image info
  const apiUrl = `https://commons.wikimedia.org/w/api.php?action=query&titles=File:${encodeURIComponent(fileName)}&prop=imageinfo&iiprop=url|user|extmetadata&format=json`;

  const response = await fetch(apiUrl, {
    headers: { 'User-Agent': 'MagicalStory/1.0 (https://magicalstory.ch)' }
  });

  const data = await response.json();
  const pages = data.query?.pages;
  const page = pages ? Object.values(pages)[0] : null;
  const imageInfo = page?.imageinfo?.[0];

  if (!imageInfo?.url) {
    throw new Error('Could not get image URL from Wikimedia API');
  }

  return {
    url: imageInfo.url,
    attribution: `Photo by ${imageInfo.user || 'Unknown'} via Wikimedia Commons`,
    license: imageInfo.extmetadata?.LicenseShortName?.value || 'Public Domain'
  };
}

/**
 * Download image and convert to base64
 */
async function downloadImage(url) {
  console.log(`  Downloading image...`);

  const response = await fetch(url, {
    headers: { 'User-Agent': 'MagicalStory/1.0 (https://magicalstory.ch)' }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || 'image/jpeg';
  const buffer = await response.arrayBuffer();

  let mimeType = 'image/jpeg';
  if (contentType.includes('png')) mimeType = 'image/png';
  else if (contentType.includes('webp')) mimeType = 'image/webp';

  const base64 = Buffer.from(buffer).toString('base64');
  console.log(`  Downloaded: ${Math.round(buffer.byteLength / 1024)}KB`);

  return {
    data: `data:${mimeType};base64,${base64}`,
    buffer: Buffer.from(buffer),
    mimeType
  };
}

/**
 * Compress image using sharp (if available)
 */
async function compressImage(buffer, maxSize = 768) {
  try {
    const sharp = require('sharp');
    const compressed = await sharp(buffer)
      .resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    console.log(`  Compressed: ${Math.round(buffer.length / 1024)}KB → ${Math.round(compressed.length / 1024)}KB`);
    return {
      data: `data:image/jpeg;base64,${compressed.toString('base64')}`,
      buffer: compressed
    };
  } catch {
    console.log('  Sharp not available, using original size');
    return {
      data: `data:image/jpeg;base64,${buffer.toString('base64')}`,
      buffer
    };
  }
}

/**
 * Evaluate image with Gemini
 */
async function evaluateImage(base64Data, locationName, locationType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log('  No Gemini API key, skipping evaluation');
    return { score: 5, reason: 'No API key', description: locationName };
  }

  console.log(`  Evaluating with Gemini...`);

  const matches = base64Data.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!matches) {
    return { score: 5, reason: 'Invalid image data', description: locationName };
  }

  const [, mimeType, data] = matches;

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
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inlineData: { mimeType, data } }
            ]
          }],
          generationConfig: {
            maxOutputTokens: 300,
            temperature: 0.3
          }
        }),
        signal: AbortSignal.timeout(30000)
      }
    );

    if (!response.ok) {
      console.log(`  Gemini API error: ${response.status}`);
      return { score: 5, reason: 'API error', description: locationName };
    }

    const result = await response.json();
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!text) {
      return { score: 5, reason: 'No response', description: locationName };
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log(`  Score: ${parsed.score}/10 - ${parsed.reason}`);
      console.log(`  Description: ${parsed.description}`);
      return parsed;
    }

    return { score: 5, reason: 'Parse error', description: locationName };
  } catch (err) {
    console.log(`  Evaluation error: ${err.message}`);
    return { score: 5, reason: err.message, description: locationName };
  }
}

/**
 * Save image to folder and update databank
 */
async function saveImage(eventId, locationName, imageBuffer, evaluation, wikimediaInfo) {
  const eventDisplayName = EVENT_NAMES[eventId] || eventId;
  const locationSlug = slugify(locationName);

  // Create folder structure with display names
  const eventFolder = path.join(IMAGES_FOLDER, eventDisplayName);
  const locationFolder = path.join(eventFolder, locationName);

  if (!fs.existsSync(locationFolder)) {
    fs.mkdirSync(locationFolder, { recursive: true });
  }

  // Find next available image number
  const existingFiles = fs.readdirSync(locationFolder).filter(f => /^\d+-score-\d+\.jpg$/.test(f));
  const nextNum = existingFiles.length + 1;

  // Save image file
  const fileName = `${nextNum}-score-${evaluation.score}.jpg`;
  const filePath = path.join(locationFolder, fileName);
  fs.writeFileSync(filePath, imageBuffer);
  console.log(`\n  Saved: ${filePath}`);

  // Update databank
  if (fs.existsSync(DATABANK_FILE)) {
    const databank = JSON.parse(fs.readFileSync(DATABANK_FILE, 'utf-8'));

    if (databank[eventId]) {
      const location = databank[eventId].locations?.find(l =>
        slugify(l.name) === locationSlug || l.name.toLowerCase() === locationName.toLowerCase()
      );

      if (location) {
        // Add or update photo
        if (!location.photos) location.photos = [];

        location.photos.push({
          photoUrl: wikimediaInfo.url,
          photoData: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`,
          attribution: wikimediaInfo.attribution,
          description: evaluation.description,
          score: evaluation.score,
          reason: evaluation.reason
        });

        // Sort by score, keep top ones
        location.photos.sort((a, b) => b.score - a.score);

        // Update timestamp
        databank[eventId].lastUpdated = new Date().toISOString();

        fs.writeFileSync(DATABANK_FILE, JSON.stringify(databank, null, 2));
        console.log(`  Updated databank: ${eventId} → ${locationName}`);
      } else {
        console.log(`  Warning: Location "${locationName}" not found in databank for ${eventId}`);
      }
    } else {
      console.log(`  Warning: Event "${eventId}" not found in databank`);
    }
  }

  return filePath;
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 3) {
    console.log('Usage: node add-historical-image.js <wikimedia-url> <event-id> <location-name>');
    console.log('');
    console.log('Example:');
    console.log('  node server/scripts/add-historical-image.js \\');
    console.log('    "https://commons.wikimedia.org/wiki/File:Example.jpg" \\');
    console.log('    "moon-landing" \\');
    console.log('    "Kennedy Space Center"');
    console.log('');
    console.log('Available events:');
    for (const [id, name] of Object.entries(EVENT_NAMES)) {
      console.log(`  ${id.padEnd(25)} → ${name}`);
    }
    process.exit(1);
  }

  const [wikimediaUrl, eventId, ...locationParts] = args;
  const locationName = locationParts.join(' ');

  console.log('='.repeat(60));
  console.log('Add Historical Location Image');
  console.log('='.repeat(60));
  console.log(`\nEvent: ${EVENT_NAMES[eventId] || eventId}`);
  console.log(`Location: ${locationName}`);
  console.log(`URL: ${wikimediaUrl}\n`);

  try {
    // Step 1: Get image URL from Wikimedia
    console.log('Step 1: Resolving Wikimedia URL...');
    const wikimediaInfo = await getWikimediaImageUrl(wikimediaUrl);
    console.log(`  Direct URL: ${wikimediaInfo.url}`);
    console.log(`  Attribution: ${wikimediaInfo.attribution}`);

    // Step 2: Download image
    console.log('\nStep 2: Downloading image...');
    const downloaded = await downloadImage(wikimediaInfo.url);

    // Step 3: Compress image
    console.log('\nStep 3: Compressing image...');
    const compressed = await compressImage(downloaded.buffer, 1024);

    // Step 4: Evaluate with Gemini
    console.log('\nStep 4: Evaluating image quality...');
    const evaluation = await evaluateImage(compressed.data, locationName, 'landmark');

    // Step 5: Save to folder and databank
    console.log('\nStep 5: Saving image...');
    const savedPath = await saveImage(eventId, locationName, compressed.buffer, evaluation, wikimediaInfo);

    console.log('\n' + '='.repeat(60));
    console.log('SUCCESS');
    console.log('='.repeat(60));
    console.log(`Image saved to: ${savedPath}`);
    console.log(`Score: ${evaluation.score}/10`);
    console.log(`Description: ${evaluation.description}`);

  } catch (err) {
    console.error('\nError:', err.message);
    process.exit(1);
  }
}

main();
