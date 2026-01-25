/**
 * Extract bounding box regions from a story image
 * Usage: node scripts/extract-bbox-crops.js <storyId> <pageNum>
 */

const { Pool } = require('pg');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Load prompts before using detection
const { loadPromptTemplates } = require('../server/services/prompts');

const OUTPUT_DIR = path.join(__dirname, '../tests/fixtures/bbox-crops');

async function main() {
  const storyId = process.argv[2] || '73';
  const pageNum = parseInt(process.argv[3] || '3');

  console.log(`Extracting bbox crops for story ${storyId}, page ${pageNum}...`);

  // Load prompt templates first
  await loadPromptTemplates();
  console.log('Loaded prompt templates');

  // Ensure output dir exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // Get image from story_images table (latest version)
    const imageResult = await pool.query(
      `SELECT image_data FROM story_images
       WHERE story_id = $1 AND page_number = $2
       ORDER BY version_index DESC, created_at DESC
       LIMIT 1`,
      [storyId, pageNum]
    );

    if (!imageResult.rows[0]?.image_data) {
      console.error('No image found for page', pageNum);
      return;
    }

    const imageData = imageResult.rows[0].image_data;
    console.log('Found image, size:', Math.round(imageData.length / 1024), 'KB');

    // Extract base64 data
    const base64Match = imageData.match(/^data:image\/\w+;base64,(.+)$/);
    const base64Data = base64Match ? base64Match[1] : imageData;
    const imageBuffer = Buffer.from(base64Data, 'base64');

    // Save original image
    const originalPath = path.join(OUTPUT_DIR, `page${pageNum}_original.png`);
    await sharp(imageBuffer).png().toFile(originalPath);
    console.log('Saved original:', originalPath);

    // Get image dimensions
    const metadata = await sharp(imageBuffer).metadata();
    console.log('Image dimensions:', metadata.width, 'x', metadata.height);

    // Now run bbox detection using Gemini
    const { detectAllBoundingBoxes } = require('../server/lib/images');

    console.log('Running bbox detection...');
    const detections = await detectAllBoundingBoxes(imageData);

    if (!detections) {
      console.error('Bbox detection failed');
      return;
    }

    console.log(`Detected ${detections.figures.length} figures, ${detections.objects.length} objects`);

    // Crop and save each figure
    for (let i = 0; i < detections.figures.length; i++) {
      const fig = detections.figures[i];
      console.log(`Figure ${i + 1}: ${fig.label} at ${fig.position}`);

      // Body box
      if (fig.bodyBox) {
        const [ymin, xmin, ymax, xmax] = fig.bodyBox;
        const left = Math.round(xmin * metadata.width);
        const top = Math.round(ymin * metadata.height);
        const width = Math.round((xmax - xmin) * metadata.width);
        const height = Math.round((ymax - ymin) * metadata.height);

        const bodyPath = path.join(OUTPUT_DIR, `page${pageNum}_fig${i + 1}_${fig.label}_body.png`);
        await sharp(imageBuffer)
          .extract({ left, top, width, height })
          .png()
          .toFile(bodyPath);
        console.log(`  Body: ${bodyPath}`);
      }

      // Face box
      if (fig.faceBox) {
        const [ymin, xmin, ymax, xmax] = fig.faceBox;
        const left = Math.round(xmin * metadata.width);
        const top = Math.round(ymin * metadata.height);
        const width = Math.round((xmax - xmin) * metadata.width);
        const height = Math.round((ymax - ymin) * metadata.height);

        const facePath = path.join(OUTPUT_DIR, `page${pageNum}_fig${i + 1}_${fig.label}_face.png`);
        await sharp(imageBuffer)
          .extract({ left, top, width, height })
          .png()
          .toFile(facePath);
        console.log(`  Face: ${facePath}`);
      }
    }

    // Crop and save each object
    for (let i = 0; i < detections.objects.length; i++) {
      const obj = detections.objects[i];
      console.log(`Object ${i + 1}: ${obj.label} at ${obj.position}`);

      if (obj.bodyBox) {
        const [ymin, xmin, ymax, xmax] = obj.bodyBox;
        const left = Math.round(xmin * metadata.width);
        const top = Math.round(ymin * metadata.height);
        const width = Math.round((xmax - xmin) * metadata.width);
        const height = Math.round((ymax - ymin) * metadata.height);

        const objPath = path.join(OUTPUT_DIR, `page${pageNum}_obj${i + 1}_${obj.label.replace(/\s+/g, '_')}.png`);
        await sharp(imageBuffer)
          .extract({ left, top, width, height })
          .png()
          .toFile(objPath);
        console.log(`  Saved: ${objPath}`);
      }
    }

    console.log('\nDone! Crops saved to:', OUTPUT_DIR);

  } finally {
    await pool.end();
  }
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
