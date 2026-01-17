#!/usr/bin/env node
/**
 * Upload Historical Location Images
 *
 * Reads images from local folders, evaluates them with Gemini,
 * uploads to database, and moves files to "uploaded" folder.
 *
 * Usage: node server/scripts/upload-historical-images.js [event-id]
 *
 * Example:
 *   node server/scripts/upload-historical-images.js moon-landing
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const PENDING_FOLDER = path.join(__dirname, '../../historical-location-images');
const UPLOADED_FOLDER = path.join(__dirname, '../../historical-location-images-uploaded');
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

// Reverse mapping: display name -> event ID
const EVENT_IDS = Object.fromEntries(
  Object.entries(EVENT_NAMES).map(([id, name]) => [name, id])
);

/**
 * Compress image using sharp
 */
async function compressImage(buffer, maxSize = 1024) {
  try {
    const sharp = require('sharp');
    const compressed = await sharp(buffer)
      .resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    return compressed;
  } catch {
    return buffer;
  }
}

/**
 * Evaluate image with Gemini
 */
async function evaluateImage(buffer, locationName, locationType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log('    No Gemini API key, using placeholder description');
    return { score: 5, reason: 'No API key', description: locationName };
  }

  const base64 = buffer.toString('base64');
  const mimeType = 'image/jpeg';

  const prompt = `Analyze this photo of "${locationName}"${locationType ? ` (a ${locationType})` : ''} for use in children's book illustration.

TASK 1 - SCORE (1-10):
Rate suitability as a children's book background based on:
- Clarity: Sharp and well-lit? (not blurry or dark)
- Composition: Shows the landmark clearly and completely?
- Suitability: Works as background? (not too busy, no distracting people/cars/signs)

TASK 2 - DESCRIPTION:
Write a detailed visual description (4-6 sentences) focusing on:
- The main architectural/natural features visible
- Colors, materials, textures
- Distinctive elements that make it recognizable
- The setting/surroundings visible in the photo
- Lighting and atmosphere

Be specific and visual. Do NOT mention "the photo" or "the image" - describe as if painting the scene.

Return ONLY valid JSON (no markdown):
{"score": N, "reason": "1-sentence scoring explanation", "description": "4-6 sentence detailed visual description"}`;

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
              { inlineData: { mimeType, data: base64 } }
            ]
          }],
          generationConfig: {
            maxOutputTokens: 500,
            temperature: 0.3
          }
        }),
        signal: AbortSignal.timeout(30000)
      }
    );

    if (!response.ok) {
      return { score: 5, reason: 'API error', description: locationName };
    }

    const result = await response.json();
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!text) {
      return { score: 5, reason: 'No response', description: locationName };
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    return { score: 5, reason: 'Parse error', description: locationName };
  } catch (err) {
    return { score: 5, reason: err.message, description: locationName };
  }
}

/**
 * Main upload function
 */
async function main() {
  const args = process.argv.slice(2);
  const filterEventId = args[0];

  console.log('='.repeat(60));
  console.log('Upload Historical Location Images');
  console.log('='.repeat(60));

  if (!fs.existsSync(PENDING_FOLDER)) {
    console.error(`\nError: Pending folder not found: ${PENDING_FOLDER}`);
    process.exit(1);
  }

  if (!fs.existsSync(DATABANK_FILE)) {
    console.error(`\nError: Databank not found: ${DATABANK_FILE}`);
    process.exit(1);
  }

  // Create uploaded folder if needed
  if (!fs.existsSync(UPLOADED_FOLDER)) {
    fs.mkdirSync(UPLOADED_FOLDER, { recursive: true });
  }

  const databank = JSON.parse(fs.readFileSync(DATABANK_FILE, 'utf-8'));

  // Scan pending folder for event folders
  const eventFolders = fs.readdirSync(PENDING_FOLDER, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  let totalUploaded = 0;
  let totalMoved = 0;

  for (const eventFolder of eventFolders) {
    // Get event ID from folder name
    const eventId = EVENT_IDS[eventFolder] || eventFolder;

    // Filter by event ID if specified
    if (filterEventId && eventId !== filterEventId) {
      continue;
    }

    if (!databank[eventId]) {
      console.log(`\n[${eventFolder}] - NOT IN DATABANK (skipped)`);
      continue;
    }

    const eventPath = path.join(PENDING_FOLDER, eventFolder);
    const locationFolders = fs.readdirSync(eventPath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    console.log(`\n[${eventFolder}] - ${locationFolders.length} location(s)`);

    for (const locationFolder of locationFolders) {
      const locationPath = path.join(eventPath, locationFolder);

      // Find matching location in databank
      const location = databank[eventId].locations?.find(l =>
        l.name === locationFolder || l.name.toLowerCase() === locationFolder.toLowerCase()
      );

      if (!location) {
        console.log(`  ${locationFolder}: NOT IN DATABANK (skipped)`);
        continue;
      }

      // Get image files
      const imageFiles = fs.readdirSync(locationPath)
        .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
        .sort();

      if (imageFiles.length === 0) {
        console.log(`  ${locationFolder}: No images (skipped)`);
        continue;
      }

      console.log(`  ${locationFolder}: ${imageFiles.length} image(s)`);

      // Initialize photos array if needed
      if (!location.photos) location.photos = [];

      for (const imageFile of imageFiles) {
        const imagePath = path.join(locationPath, imageFile);

        try {
          // Read and compress image
          let buffer = fs.readFileSync(imagePath);
          buffer = await compressImage(buffer, 1024);

          // Evaluate with Gemini
          console.log(`    Evaluating ${imageFile}...`);
          const evaluation = await evaluateImage(buffer, location.name, location.type || 'landmark');
          console.log(`      Score: ${evaluation.score}/10`);
          console.log(`      ${evaluation.description.substring(0, 60)}...`);

          // Add to database
          location.photos.push({
            photoUrl: '',
            photoData: `data:image/jpeg;base64,${buffer.toString('base64')}`,
            attribution: 'Photo via Wikimedia Commons',
            description: evaluation.description,
            score: evaluation.score,
            reason: evaluation.reason
          });
          totalUploaded++;

          // Move file to uploaded folder
          const uploadedEventPath = path.join(UPLOADED_FOLDER, eventFolder);
          const uploadedLocationPath = path.join(uploadedEventPath, locationFolder);
          if (!fs.existsSync(uploadedLocationPath)) {
            fs.mkdirSync(uploadedLocationPath, { recursive: true });
          }

          const newFileName = `${location.photos.length}-score-${evaluation.score}.jpg`;
          const uploadedFilePath = path.join(uploadedLocationPath, newFileName);
          fs.renameSync(imagePath, uploadedFilePath);
          totalMoved++;

          // Small delay to avoid rate limiting
          await new Promise(r => setTimeout(r, 500));
        } catch (err) {
          console.error(`    Error processing ${imageFile}: ${err.message}`);
        }
      }

      // Sort photos by score
      location.photos.sort((a, b) => b.score - a.score);

      // Save incrementally
      databank[eventId].lastUpdated = new Date().toISOString();
      fs.writeFileSync(DATABANK_FILE, JSON.stringify(databank, null, 2));
    }

    // Clean up empty folders
    for (const locationFolder of locationFolders) {
      const locationPath = path.join(eventPath, locationFolder);
      const remaining = fs.readdirSync(locationPath).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
      if (remaining.length === 0) {
        fs.rmdirSync(locationPath, { recursive: true });
      }
    }

    // Check if event folder is empty
    const remainingLocs = fs.readdirSync(eventPath, { withFileTypes: true }).filter(d => d.isDirectory());
    if (remainingLocs.length === 0) {
      fs.rmdirSync(eventPath, { recursive: true });
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('UPLOAD COMPLETE');
  console.log('='.repeat(60));
  console.log(`Uploaded: ${totalUploaded} images`);
  console.log(`Moved to: ${UPLOADED_FOLDER}`);

  // Show databank size
  const stats = fs.statSync(DATABANK_FILE);
  console.log(`Databank: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
