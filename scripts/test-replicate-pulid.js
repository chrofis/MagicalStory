/**
 * Replicate PuLID-FLUX Face Identity Test
 *
 * Tests Replicate's PuLID-FLUX model for high-quality face identity preservation.
 * Uses FLUX model (not SDXL) for much better results than Runware.
 *
 * Usage:
 *   node scripts/test-replicate-pulid.js <image-path> [prompt]
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

if (!REPLICATE_API_TOKEN) {
  console.error('Error: REPLICATE_API_TOKEN not found in .env');
  process.exit(1);
}

const VIEWS = [
  {
    name: 'front-face',
    prompt: 'professional portrait photo, close-up headshot, front view, looking directly at camera, friendly natural expression, soft studio lighting, light gray background, sharp focus, high detail, 8k quality, photorealistic'
  },
  {
    name: 'three-quarter-face',
    prompt: 'professional portrait photo, close-up headshot, three quarter view, face turned 45 degrees to the right, looking at camera, friendly natural expression, soft studio lighting, light gray background, sharp focus, high detail, 8k quality, photorealistic'
  }
];

async function generateWithReplicatePuLID(imageDataUri, prompt, options = {}) {
  const {
    width = 1024,
    height = 1024,
    idWeight = 1.0,
    steps = 20,
    guidanceScale = 4
  } = options;

  console.log(`  Calling Replicate PuLID-FLUX API...`);

  // Start prediction using version-based endpoint
  const response = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json',
      'Prefer': 'wait'  // Wait for completion
    },
    body: JSON.stringify({
      version: '8baa7ef2255075b46f4d91cd238c21d31181b3e6a864463f967960bb0112525b',
      input: {
        main_face_image: imageDataUri,
        prompt: prompt,
        width: width,
        height: height,
        id_weight: idWeight,
        num_steps: steps,
        guidance_scale: guidanceScale,
        output_format: 'png',
        num_outputs: 1
      }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Replicate API error: ${response.status} - ${error}`);
  }

  let prediction = await response.json();

  // If not completed yet, poll for result
  while (prediction.status === 'starting' || prediction.status === 'processing') {
    console.log(`  Status: ${prediction.status}...`);
    await new Promise(resolve => setTimeout(resolve, 2000));

    const pollResponse = await fetch(prediction.urls.get, {
      headers: { 'Authorization': `Bearer ${REPLICATE_API_TOKEN}` }
    });
    prediction = await pollResponse.json();
  }

  if (prediction.status === 'failed') {
    throw new Error(`Generation failed: ${prediction.error}`);
  }

  // Get the output image URL
  const outputUrl = prediction.output[0];

  // Download the image
  const imageResponse = await fetch(outputUrl);
  const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
  const imageBase64 = imageBuffer.toString('base64');

  return {
    imageData: `data:image/png;base64,${imageBase64}`,
    metrics: prediction.metrics,
    status: prediction.status
  };
}

async function generateCharacterSheet(imagePath, outputPrefix) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Generating 2 views for: ${path.basename(imagePath)}`);
  console.log('='.repeat(60));

  // Load image as base64 data URI
  const imageBuffer = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
  const imageData = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
  console.log(`Loaded: ${Math.round(imageBuffer.length / 1024)}KB\n`);

  const results = [];
  const startTime = Date.now();

  for (let i = 0; i < VIEWS.length; i++) {
    const view = VIEWS[i];

    // Add delay between requests to avoid rate limiting
    if (i > 0) {
      console.log('  Waiting 15s to avoid rate limit...');
      await new Promise(resolve => setTimeout(resolve, 15000));
    }

    console.log(`Generating ${view.name}...`);
    const viewStart = Date.now();

    try {
      const result = await generateWithReplicatePuLID(imageData, view.prompt, {
        width: 1024,
        height: 1024,
        idWeight: 1.0,
        steps: 20,
        guidanceScale: 4
      });

      const elapsed = Date.now() - viewStart;

      // Save output
      const outputDir = path.join(__dirname, '..', 'test-output');
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      const outputPath = path.join(outputDir, `replicate-${outputPrefix}-${view.name}.png`);

      let base64 = result.imageData;
      if (base64.startsWith('data:')) {
        base64 = base64.split(',')[1];
      }
      fs.writeFileSync(outputPath, Buffer.from(base64, 'base64'));

      const predictTime = result.metrics?.predict_time ? `${result.metrics.predict_time.toFixed(1)}s` : 'N/A';
      console.log(`  Done: ${(elapsed/1000).toFixed(1)}s total, ${predictTime} GPU time`);
      results.push({ view: view.name, success: true, path: outputPath });

    } catch (error) {
      console.log(`  Failed: ${error.message}`);
      results.push({ view: view.name, success: false, error: error.message });
    }
  }

  const totalTime = (Date.now() - startTime) / 1000;
  console.log(`\nComplete: ${totalTime.toFixed(1)}s total`);
  console.log(`Output files: replicate-${outputPrefix}-*.png`);

  return { results, totalTime };
}

async function main() {
  const manuel = 'C:/Users/roger/OneDrive/Pictures/Manuel2.jpg';
  const franziska = 'C:/Users/roger/OneDrive/Pictures/Franziska.jpg';

  console.log('Replicate PuLID-FLUX Face Identity Test');
  console.log('=======================================\n');
  console.log('Using FLUX model for higher quality face preservation\n');

  // Generate for Manuel
  await generateCharacterSheet(manuel, 'manuel');

  // Delay before next person
  console.log('\nWaiting 20s before next person...');
  await new Promise(resolve => setTimeout(resolve, 20000));

  // Generate for Franziska
  await generateCharacterSheet(franziska, 'franziska');

  console.log('\n' + '='.repeat(60));
  console.log('All done! Check test-output/ for:');
  console.log('  replicate-manuel-front-face.png');
  console.log('  replicate-manuel-three-quarter-face.png');
  console.log('  replicate-franziska-front-face.png');
  console.log('  replicate-franziska-three-quarter-face.png');
  console.log('='.repeat(60));
}

main().catch(console.error);
