#!/usr/bin/env node
/**
 * Sync Historical Location Images
 *
 * This script reads edited images from the local folder structure
 * and updates the historical-locations.json databank.
 *
 * Usage: node server/scripts/sync-historical-images.js
 *
 * Folder structure expected:
 *   historical-location-images/{event-id}/{location-slug}/1-score-N.jpg
 */

const fs = require('fs');
const path = require('path');

const IMAGES_FOLDER = path.join(__dirname, '../../historical-location-images');
const DATABANK_FILE = path.join(__dirname, '../data/historical-locations.json');

/**
 * Convert location name to slug (matching the extraction script)
 */
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Read image file and convert to base64 data URL
 */
function imageToBase64(filePath) {
  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();

  let mimeType = 'image/jpeg';
  if (ext === '.png') mimeType = 'image/png';
  else if (ext === '.webp') mimeType = 'image/webp';

  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

/**
 * Main sync function
 */
function syncImages() {
  console.log('='.repeat(60));
  console.log('Historical Location Image Sync');
  console.log('='.repeat(60));

  // Check if images folder exists
  if (!fs.existsSync(IMAGES_FOLDER)) {
    console.error(`\nError: Images folder not found: ${IMAGES_FOLDER}`);
    console.log('Run the extract script first or create the folder structure.');
    process.exit(1);
  }

  // Load existing databank
  if (!fs.existsSync(DATABANK_FILE)) {
    console.error(`\nError: Databank not found: ${DATABANK_FILE}`);
    console.log('Run the prefetch script first.');
    process.exit(1);
  }

  const databank = JSON.parse(fs.readFileSync(DATABANK_FILE, 'utf-8'));
  console.log(`\nLoaded databank with ${Object.keys(databank).length} events`);

  // Build a lookup map: eventId -> locationSlug -> location object
  const locationMap = new Map();
  for (const [eventId, eventData] of Object.entries(databank)) {
    const locMap = new Map();
    for (const loc of eventData.locations || []) {
      const slug = slugify(loc.name);
      locMap.set(slug, loc);
    }
    locationMap.set(eventId, locMap);
  }

  // Scan images folder
  const eventFolders = fs.readdirSync(IMAGES_FOLDER, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  console.log(`Found ${eventFolders.length} event folders\n`);

  let updatedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const eventId of eventFolders) {
    const eventPath = path.join(IMAGES_FOLDER, eventId);
    const locFolders = fs.readdirSync(eventPath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    if (!locationMap.has(eventId)) {
      console.log(`[${eventId}] - NOT IN DATABANK (skipped)`);
      skippedCount += locFolders.length;
      continue;
    }

    console.log(`[${eventId}] - ${locFolders.length} location(s)`);
    const eventLocMap = locationMap.get(eventId);

    for (const locSlug of locFolders) {
      const locPath = path.join(eventPath, locSlug);

      // Find matching location in databank
      const location = eventLocMap.get(locSlug);
      if (!location) {
        console.log(`  ${locSlug}: NOT FOUND in databank (skipped)`);
        skippedCount++;
        continue;
      }

      // Get image files (sorted by name)
      const imageFiles = fs.readdirSync(locPath)
        .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
        .sort();

      if (imageFiles.length === 0) {
        console.log(`  ${locSlug}: No images found (skipped)`);
        skippedCount++;
        continue;
      }

      // Check if we have matching number of photos
      const existingPhotos = location.photos || [];
      if (imageFiles.length !== existingPhotos.length) {
        console.log(`  ${locSlug}: Image count mismatch (${imageFiles.length} files vs ${existingPhotos.length} in databank)`);
      }

      // Update each photo
      let locUpdated = false;
      for (let i = 0; i < imageFiles.length && i < existingPhotos.length; i++) {
        const imagePath = path.join(locPath, imageFiles[i]);

        try {
          const newBase64 = imageToBase64(imagePath);
          const oldSize = existingPhotos[i].photoData?.length || 0;
          const newSize = newBase64.length;

          // Only update if different (compare sizes as quick check)
          if (oldSize !== newSize) {
            existingPhotos[i].photoData = newBase64;
            locUpdated = true;
            console.log(`  ${locSlug}: Updated photo ${i + 1} (${Math.round(newSize/1024)}KB)`);
          }
        } catch (err) {
          console.error(`  ${locSlug}: Error reading ${imageFiles[i]}: ${err.message}`);
          errorCount++;
        }
      }

      if (locUpdated) {
        updatedCount++;
      }
    }
  }

  // Save updated databank
  if (updatedCount > 0) {
    fs.writeFileSync(DATABANK_FILE, JSON.stringify(databank, null, 2));
    console.log('\n' + '='.repeat(60));
    console.log('SYNC COMPLETE');
    console.log('='.repeat(60));
    console.log(`Updated: ${updatedCount} locations`);
    console.log(`Skipped: ${skippedCount} locations`);
    console.log(`Errors:  ${errorCount}`);
    console.log(`\nDatabank saved: ${DATABANK_FILE}`);
  } else {
    console.log('\n' + '='.repeat(60));
    console.log('NO CHANGES');
    console.log('='.repeat(60));
    console.log('All images match the databank (no updates needed).');
  }
}

// Run
syncImages();
